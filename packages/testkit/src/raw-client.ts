import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  RequestId,
  RequestMetaObject,
  SubscriptionFilter,
  Tool,
} from "@fetchling/protocol";
import type { FakeUpstream } from "./fake.js";
import { isObject, type JsonObject } from "./json.js";
import { requestHeaders } from "./mcp-headers.js";
import { meta } from "./meta.js";
import { createSseParser } from "./sse.js";
import { isResponse } from "./steps.js";

/** Where a raw client connects: a fake, any HTTP endpoint, or any command speaking stdio. */
export type ClientTarget =
  | FakeUpstream
  | { url: string }
  | { command: string; args?: readonly string[] };

export interface RawRequestOptions {
  /** Default: this client's next id (1, 2, …). Two clients reuse the same ids on purpose. */
  id?: RequestId;
  /** Overrides for the request `_meta` (default: complete and valid). */
  meta?: Partial<RequestMetaObject>;
  /** HTTP: extra or replacement headers; `null` removes a header the client would send. */
  headers?: Record<string, string | null>;
  /** HTTP: the called tool's definition, so its `Mcp-Param-*` headers are sent. */
  tool?: Pick<Tool, "inputSchema">;
  /** Give up after this long. Default 5000. */
  timeoutMs?: number;
  /** Abort the request: on HTTP this closes the stream, which is the cancellation signal. */
  signal?: AbortSignal;
  /**
   * HTTP: resolve as soon as the response arrives instead of waiting for the stream to
   * end. stdio always resolves on the response.
   */
  untilResponse?: boolean;
}

export interface RawExchange {
  /** HTTP status (undefined on stdio). */
  status?: number;
  /** HTTP response headers, lowercase (undefined on stdio). */
  headers?: Record<string, string>;
  /** Every message received for this request, in order: notifications, then the response. */
  messages: unknown[];
  /** The JSON-RPC response to the request, if one arrived. */
  response: JsonObject | undefined;
  /** The raw text received: the body, or one entry per SSE event / stdout line. */
  raw: string[];
}

export interface RawSubscription extends AsyncIterable<JsonObject> {
  readonly id: RequestId;
  /** The acknowledgement, once it has arrived. */
  readonly acknowledged: Promise<JsonObject>;
  /** The next notification on this stream (the acknowledgement is not included). */
  next(options?: { timeoutMs?: number }): Promise<JsonObject>;
  /** Cancel: close the stream (HTTP) or send notifications/cancelled (stdio). */
  close(): Promise<void>;
}

export interface RawClient extends AsyncDisposable {
  request(
    method: string,
    params?: JsonObject,
    options?: RawRequestOptions,
  ): Promise<RawExchange>;
  /** Send a notification. HTTP resolves with the exchange (expect 202); stdio with undefined. */
  notify(
    method: string,
    params?: JsonObject,
    options?: Pick<RawRequestOptions, "headers">,
  ): Promise<RawExchange | undefined>;
  /** Send exactly these bytes. HTTP resolves with the exchange; stdio with undefined. */
  send(
    raw: string,
    options?: Pick<RawRequestOptions, "headers" | "timeoutMs">,
  ): Promise<RawExchange | undefined>;
  listen(
    filter: SubscriptionFilter,
    options?: Pick<RawRequestOptions, "meta" | "headers" | "id">,
  ): Promise<RawSubscription>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** A client that sends exactly what it is told — valid by default, anything on request. */
export function rawClient(target: ClientTarget): RawClient {
  const resolved = resolveTarget(target);
  return "url" in resolved
    ? httpClient(resolved.url)
    : stdioClient(resolved.command, resolved.args);
}

/** Several independent clients against one target. Each numbers its ids from 1. */
export function rawClients(target: ClientTarget, count: number): RawClient[] {
  return Array.from({ length: count }, () => rawClient(target));
}

function resolveTarget(
  target: ClientTarget,
): { url: string } | { command: string; args: readonly string[] } {
  if ("transport" in target) {
    const entry = target.mcpServerEntry();
    return "url" in entry
      ? { url: entry.url }
      : { command: entry.command, args: entry.args };
  }
  if ("url" in target) return { url: target.url };
  return { command: target.command, args: target.args ?? [] };
}

function buildMessage(
  method: string,
  params: JsonObject,
  id: RequestId | undefined,
  overrides: Partial<RequestMetaObject> = {},
): JsonObject {
  const body: JsonObject = {
    jsonrpc: "2.0",
    method,
    params: { ...params, _meta: meta(overrides) },
  };
  if (id !== undefined) body.id = id;
  return body;
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseTo(messages: unknown[], id: unknown): JsonObject | undefined {
  return messages.find(
    (m): m is JsonObject => isObject(m) && isResponse(m) && m.id === id,
  );
}

// ── HTTP ────────────────────────────────────────────────────────────────────────

function httpClient(url: string): RawClient {
  let nextId = 1;
  const open = new Set<AbortController>();

  async function post(
    body: string,
    headers: Record<string, string>,
    options: { timeoutMs?: number; signal?: AbortSignal; untilId?: unknown },
  ): Promise<RawExchange> {
    const controller = new AbortController();
    open.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error("raw client timeout")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(url, { method: "POST", body, headers, signal });
      const exchange: RawExchange = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        messages: [],
        response: undefined,
        raw: [],
      };
      const type = response.headers.get("content-type") ?? "";
      if (type.startsWith("text/event-stream") && response.body) {
        const parser = createSseParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        const take = (events: string[]) => {
          for (const data of events) {
            exchange.raw.push(data);
            exchange.messages.push(parseOrNull(data));
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          take(parser.push(decoder.decode(value, { stream: true })));
          if (
            options.untilId !== undefined &&
            responseTo(exchange.messages, options.untilId)
          ) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
        take(parser.flush());
      } else {
        const text = await response.text();
        if (text !== "") {
          exchange.raw.push(text);
          exchange.messages.push(parseOrNull(text));
        }
      }
      exchange.response = messagesResponse(exchange.messages);
      return exchange;
    } finally {
      clearTimeout(timer);
      open.delete(controller);
    }
  }

  function headersFor(
    message: JsonObject,
    options: Pick<RawRequestOptions, "headers" | "tool">,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...requestHeaders(message, options.tool),
    };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const lower = name.toLowerCase();
      if (value === null) delete headers[lower];
      else headers[lower] = value;
    }
    return headers;
  }

  const client: RawClient = {
    async request(method, params = {}, options = {}) {
      const id = options.id ?? nextId++;
      const message = buildMessage(method, params, id, options.meta);
      const exchange = await post(
        JSON.stringify(message),
        headersFor(message, options),
        {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.untilResponse ? { untilId: id } : {}),
        },
      );
      exchange.response = responseTo(exchange.messages, id) ?? exchange.response;
      return exchange;
    },
    async notify(method, params = {}, options = {}) {
      const message = buildMessage(method, params, undefined);
      return post(JSON.stringify(message), headersFor(message, options), {});
    },
    async send(raw, options = {}) {
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (value === null) delete headers[name.toLowerCase()];
        else headers[name.toLowerCase()] = value;
      }
      return post(
        raw,
        headers,
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      );
    },
    async listen(filter, options = {}) {
      const id = options.id ?? nextId++;
      const message = buildMessage(
        "subscriptions/listen",
        { notifications: filter },
        id,
        options.meta,
      );
      const controller = new AbortController();
      open.add(controller);
      const queue = createQueue<JsonObject>();
      let acknowledge: (ack: JsonObject) => void = () => {};
      const acknowledged = new Promise<JsonObject>((resolve) => {
        acknowledge = resolve;
      });
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(message),
        headers: headersFor(message, options),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        open.delete(controller);
        throw new Error(
          `subscriptions/listen failed with HTTP ${response.status}: ${await response.text()}`,
        );
      }
      const reader = response.body.getReader();
      const parser = createSseParser();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const data of parser.push(decoder.decode(value, { stream: true }))) {
              const parsed = parseOrNull(data);
              if (!isObject(parsed)) continue;
              if (parsed.method === "notifications/subscriptions/acknowledged")
                acknowledge(parsed);
              else queue.push(parsed);
            }
          }
        } catch {
          // aborted by close(): the stream is gone
        } finally {
          queue.end();
          open.delete(controller);
        }
      })();
      return subscription(id, acknowledged, queue, async () => {
        controller.abort();
      });
    },
    async close() {
      for (const controller of open) controller.abort();
      open.clear();
    },
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };
  return client;
}

function messagesResponse(messages: unknown[]): JsonObject | undefined {
  return messages.find((m): m is JsonObject => isObject(m) && isResponse(m));
}

// ── stdio ───────────────────────────────────────────────────────────────────────

function stdioClient(command: string, args: readonly string[]): RawClient {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume(); // stderr is for logs; never let it fill up and block the child
  child.stdin.on("error", () => {}); // writing to a dead child must not crash the test
  let nextId = 1;
  let exited = false;
  const pending = new Map<
    string,
    { exchange: RawExchange; resolve(e: RawExchange): void; reject(e: Error): void }
  >();
  const subscriptions = new Map<
    string,
    { queue: Queue<JsonObject>; acknowledge(ack: JsonObject): void }
  >();
  const exit = new Promise<void>((resolve) => {
    child.on("exit", () => {
      exited = true;
      for (const entry of pending.values())
        entry.reject(new Error(`${command} exited before responding`));
      pending.clear();
      for (const entry of subscriptions.values()) entry.queue.end();
      subscriptions.clear();
      resolve();
    });
  });

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  lines.on("line", (line) => {
    const parsed = parseOrNull(line);
    if (!isObject(parsed)) {
      for (const entry of pending.values()) {
        entry.exchange.raw.push(line);
        entry.exchange.messages.push(parsed);
      }
      return;
    }
    const subscriptionId =
      isObject(parsed.params) && isObject(parsed.params._meta)
        ? parsed.params._meta["io.modelcontextprotocol/subscriptionId"]
        : isObject(parsed.result) && isObject(parsed.result._meta)
          ? parsed.result._meta["io.modelcontextprotocol/subscriptionId"]
          : undefined;
    const subscription =
      subscriptionId === undefined ? undefined : subscriptions.get(key(subscriptionId));
    if (subscription) {
      if (parsed.method === "notifications/subscriptions/acknowledged")
        subscription.acknowledge(parsed);
      else subscription.queue.push(parsed);
      return;
    }
    if (isResponse(parsed)) {
      const entry =
        typeof parsed.id === "string" || typeof parsed.id === "number"
          ? pending.get(key(parsed.id))
          : undefined;
      if (entry) {
        entry.exchange.raw.push(line);
        entry.exchange.messages.push(parsed);
        entry.exchange.response = parsed;
        pending.delete(key(parsed.id as RequestId));
        entry.resolve(entry.exchange);
      }
      return;
    }
    // A request-scoped notification (progress, log): attach to every open request.
    for (const entry of pending.values()) {
      entry.exchange.raw.push(line);
      entry.exchange.messages.push(parsed);
    }
  });

  const write = (text: string) => {
    if (!exited) child.stdin.write(`${text}\n`);
  };

  const client: RawClient = {
    request(method, params = {}, options = {}) {
      if (exited) return Promise.reject(new Error(`${command} is not running`));
      const id = options.id ?? nextId++;
      const message = buildMessage(method, params, id, options.meta);
      return new Promise<RawExchange>((resolve, reject) => {
        const exchange: RawExchange = { messages: [], response: undefined, raw: [] };
        const timer = setTimeout(() => {
          pending.delete(key(id));
          reject(
            new Error(
              `No response to ${method} (id ${String(id)}) within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
            ),
          );
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        pending.set(key(id), {
          exchange,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        options.signal?.addEventListener("abort", () => {
          // stdio cancellation: a notification referencing the request (cancellation.md)
          write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id },
            }),
          );
          const entry = pending.get(key(id));
          pending.delete(key(id));
          entry?.reject(new Error("cancelled"));
        });
        write(JSON.stringify(message));
      });
    },
    async notify(method, params = {}) {
      write(JSON.stringify(buildMessage(method, params, undefined)));
      return undefined;
    },
    async send(raw) {
      write(raw);
      return undefined;
    },
    async listen(filter, options = {}) {
      const id = options.id ?? nextId++;
      const queue = createQueue<JsonObject>();
      let acknowledge: (ack: JsonObject) => void = () => {};
      const acknowledged = new Promise<JsonObject>((resolve) => {
        acknowledge = resolve;
      });
      subscriptions.set(key(id), { queue, acknowledge });
      write(
        JSON.stringify(
          buildMessage(
            "subscriptions/listen",
            { notifications: filter },
            id,
            options.meta,
          ),
        ),
      );
      return subscription(id, acknowledged, queue, async () => {
        subscriptions.delete(key(id));
        queue.end();
        write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          }),
        );
      });
    },
    async close() {
      if (exited) return;
      // stdio.md § Shutdown: close stdin, wait, then escalate.
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exit;
      clearTimeout(timer);
    },
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };
  return client;
}

function key(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

// ── a small async queue for subscription notifications ──────────────────────────

interface Queue<T> {
  push(item: T): void;
  end(): void;
  next(timeoutMs: number): Promise<T>;
  iterate(): AsyncIterator<T>;
}

function createQueue<T>(): Queue<T> {
  const items: T[] = [];
  const waiters: { resolve(item: T): void; reject(error: Error): void }[] = [];
  let ended = false;
  const queue: Queue<T> = {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(item);
      else items.push(item);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error("subscription closed"));
    },
    next(timeoutMs) {
      const item = items.shift();
      if (item !== undefined) return Promise.resolve(item);
      if (ended) return Promise.reject(new Error("subscription closed"));
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          resolve: (value: T) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`No notification within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    iterate() {
      return {
        next: async () => {
          if (ended && items.length === 0) return { done: true, value: undefined };
          try {
            return { done: false, value: await queue.next(DEFAULT_TIMEOUT_MS) };
          } catch {
            return { done: true, value: undefined };
          }
        },
      };
    },
  };
  return queue;
}

function subscription(
  id: RequestId,
  acknowledged: Promise<JsonObject>,
  queue: Queue<JsonObject>,
  close: () => Promise<void>,
): RawSubscription {
  return {
    id,
    acknowledged,
    next: (options = {}) => queue.next(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    close,
    [Symbol.asyncIterator]: () => queue.iterate(),
  };
}
