import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  HEADER_MISMATCH,
  INVALID_REQUEST,
  type JSONRPCErrorResponse,
  type JSONRPCNotification,
  PARSE_ERROR,
} from "@fetchling/protocol";
import {
  type FakeUpstream,
  findTool,
  type McpServerEntry,
  type Target,
  withBehaviour,
  withFault,
  withTools,
} from "./fake.js";
import type { Behaviour, ServerFault, ServerFixture, ToolFixture } from "./fixtures.js";
import { createHandler, type Handler } from "./handler.js";
import { isObject } from "./json.js";
import { checkRequestHeaders } from "./mcp-headers.js";
import { isSingleResponse, play } from "./player.js";
import { createRecorder, type Recorder } from "./recorder.js";
import { SSE_KEEP_ALIVE, sseEvent } from "./sse.js";
import type { RawStep, SendStep, Step } from "./steps.js";
import { isResponse } from "./steps.js";
import { closingResponse, createSubscriptionRegistry } from "./subscriptions.js";

export interface StartHttpOptions {
  /** Default 127.0.0.1: local servers should not bind every interface (streamable-http.md § Security). */
  host?: string;
  /** Default 0: the OS picks a free port. Read the result from `url`. */
  port?: number;
  /** The MCP endpoint path. Default "/mcp". */
  path?: string;
}

export interface HttpFakeUpstream extends FakeUpstream {
  readonly transport: "http";
  /** The MCP endpoint, e.g. http://127.0.0.1:53124/mcp. Stays the same across restarts. */
  readonly url: string;
  /** True between a crash (or kill) and the next restart. */
  readonly down: boolean;
  /** Simulate the process dying: open connections are cut, new ones refused. */
  kill(): Promise<void>;
  /** Simulate a fresh process on the same port. Sequence counters and dieAfter start over. */
  restart(): Promise<void>;
}

const DEFAULT_KEEP_ALIVE_MS = 15_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Start a fake Streamable HTTP server (streamable-http.md, revision 2026-07-28):
 * POST-only endpoint, JSON or SSE per request, 202 for notifications, the transport's
 * status codes, `Origin` checking, header/body validation in strict mode, SSE
 * keep-alives, stream close as cancellation, and graceful subscription shutdown.
 */
export async function startHttp(
  initial: ServerFixture,
  options: StartHttpOptions = {},
): Promise<HttpFakeUpstream> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";
  const recorder: Recorder = createRecorder();
  const subscriptions = createSubscriptionRegistry();
  const inFlight = new Set<AbortController>();
  const sockets = new Set<Socket>();

  let fixture = initial;
  let counters = new WeakMap<Behaviour, number>();
  let handler: Handler = createHandler(fixture, { counters });
  let exchanges = 0;
  let down = false;
  let server: Server = createServer((req, res) => void handle(req, res));
  track(server);

  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`;

  function track(s: Server): void {
    s.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  }

  function rebuild(next: ServerFixture): void {
    // Validate first: a bad fixture must not replace a working one.
    const nextHandler = createHandler(next, { counters });
    fixture = next;
    handler = nextHandler;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const exchange = ++exchanges;
    const headers = flattenHeaders(req.headers);
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    recorder.frame({ direction: "in", raw: body, headers, exchange });

    const reject = (
      status: number,
      error?: JSONRPCErrorResponse["error"],
      id?: unknown,
    ) => {
      recorder.event({
        kind: "rejected",
        exchange,
        detail: { status, ...(error ? { code: error.code } : {}) },
      });
      if (!error) {
        res.writeHead(status).end();
        return;
      }
      const response = {
        jsonrpc: "2.0",
        ...(typeof id === "string" || typeof id === "number" ? { id } : {}),
        error,
      };
      const text = JSON.stringify(response);
      const responseHeaders = { "content-type": "application/json" };
      recorder.frame({
        direction: "out",
        raw: text,
        status,
        headers: responseHeaders,
        exchange,
      });
      res.writeHead(status, responseHeaders).end(text);
    };

    const requestPath = new URL(req.url ?? "/", "http://fake").pathname;
    if (requestPath !== path) return reject(404);
    if (!originAllowed(headers.origin, fixture.allowedOrigins)) {
      return reject(403, {
        code: INVALID_REQUEST,
        message: `Origin not allowed: ${headers.origin}`,
      });
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return reject(405);
    }

    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return reject(400, { code: PARSE_ERROR, message: "Body is not valid JSON" });
    }
    if (Array.isArray(message))
      return reject(400, {
        code: INVALID_REQUEST,
        message: "Batches are not supported",
      });
    if (!isObject(message))
      return reject(400, {
        code: INVALID_REQUEST,
        message: "Body must be a JSON-RPC object",
      });
    if (typeof message.method !== "string") {
      return reject(400, {
        code: INVALID_REQUEST,
        message: "Clients must not send responses",
      });
    }
    if (!("id" in message)) {
      // A notification: accepted with 202 and no body. The core defines none over HTTP.
      recorder.frame({ direction: "out", raw: "", status: 202, headers: {}, exchange });
      res.writeHead(202).end();
      return;
    }

    if (fixture.inbound !== "lenient" && message.id !== null) {
      const tool =
        message.method === "tools/call" && isObject(message.params)
          ? findTool(fixture, message.params.name)
          : undefined;
      const check = checkRequestHeaders(headers, message, tool);
      if (!check.ok) {
        return reject(
          400,
          { code: HEADER_MISMATCH, message: `Header mismatch: ${check.reason}` },
          message.id,
        );
      }
    }

    const steps = handler.handle(message);
    await respond(steps, res, exchange, message.id);
  }

  async function respond(
    steps: Step[],
    res: ServerResponse,
    exchange: number,
    id: unknown,
  ): Promise<void> {
    const controller = new AbortController();
    inFlight.add(controller);
    let first = true;
    let finished = false;
    let keepAlive: NodeJS.Timeout | undefined;
    const outHeaders = (headers: Record<string, string>, status: number) => {
      if (!first) return {};
      first = false;
      return { headers, status };
    };

    res.on("close", () => {
      clearInterval(keepAlive);
      inFlight.delete(controller);
      if (!finished && !down) {
        controller.abort();
        if (typeof id === "string" || typeof id === "number") subscriptions.remove(id);
        recorder.event({ kind: "cancelled", exchange, detail: { id } });
      }
    });

    const firstSend = steps.find(
      (s): s is SendStep | RawStep => s.kind === "send" || s.kind === "sendRaw",
    );
    const statusCarrying =
      firstSend?.kind === "send" && firstSend.httpStatus !== undefined;
    const mode = fixture.responseMode ?? "auto";
    const useJson =
      statusCarrying || mode === "json" || (mode === "auto" && isSingleResponse(steps));

    if (useJson) {
      let answered = false;
      await play(
        steps,
        {
          send(step) {
            if (answered) return; // a JSON body carries exactly one message
            const text =
              step.kind === "send" ? JSON.stringify(step.message) : step.text;
            const isFinal = step.kind === "sendRaw" || isResponse(step.message);
            if (!isFinal) return; // notifications cannot travel in a JSON body
            answered = true;
            finished = true;
            const status = step.kind === "send" ? (step.httpStatus ?? 200) : 200;
            const headers = { "content-type": "application/json" };
            recorder.frame({
              direction: "out",
              raw: text,
              exchange,
              ...outHeaders(headers, status),
            });
            res.writeHead(status, headers).end(text);
          },
          subscribe() {
            // A JSON body cannot carry a stream; responseMode "json" with listen is a fixture error.
          },
          crash: () => crash(),
          hold() {},
          done() {
            if (answered) return;
            finished = true;
            res
              .writeHead(500, { "content-type": "text/plain" })
              .end("testkit: script produced no response");
          },
        },
        controller.signal,
      );
      return;
    }

    const sseHeaders = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    };
    res.writeHead(200, sseHeaders);
    res.flushHeaders();
    const write = (text: string) => {
      recorder.frame({
        direction: "out",
        raw: text,
        exchange,
        ...outHeaders(sseHeaders, 200),
      });
      res.write(sseEvent(text));
    };
    const startKeepAlive = () => {
      const interval = fixture.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
      if (interval > 0 && keepAlive === undefined) {
        keepAlive = setInterval(() => res.write(SSE_KEEP_ALIVE), interval);
      }
    };

    await play(
      steps,
      {
        send(step) {
          write(step.kind === "send" ? JSON.stringify(step.message) : step.text);
        },
        subscribe(step) {
          recorder.event({
            kind: "subscription-open",
            exchange,
            detail: { id: step.subscriptionId, filter: step.filter },
          });
          subscriptions.add({
            id: step.subscriptionId,
            filter: step.filter,
            deliver: (notification) => write(JSON.stringify(notification)),
            end(graceful) {
              recorder.event({
                kind: "subscription-closed",
                exchange,
                detail: { id: step.subscriptionId, graceful },
              });
              if (graceful) write(JSON.stringify(closingResponse(step.subscriptionId)));
              finished = true;
              res.end();
            },
          });
        },
        crash: () => crash(),
        hold: startKeepAlive,
        done() {
          finished = true;
          res.end();
        },
      },
      controller.signal,
    );
  }

  function crash(): void {
    if (down) return;
    down = true;
    recorder.event({ kind: "crash" });
    subscriptions.endAll(false);
    for (const controller of inFlight) controller.abort();
    server.close();
    for (const socket of sockets) socket.destroy();
  }

  async function closeServer(): Promise<void> {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close();
    for (const socket of sockets) socket.destroy();
    await closed;
  }

  const upstream: HttpFakeUpstream = {
    name: initial.name,
    transport: "http",
    url,
    traffic: recorder,
    get down() {
      return down;
    },
    fixture: () => fixture,
    async setBehaviour(target: Target, behaviour: Behaviour) {
      rebuild(withBehaviour(fixture, target, behaviour));
    },
    async setTools(tools: ToolFixture[]) {
      rebuild(withTools(fixture, tools));
      if (handler.capabilities.tools?.listChanged) {
        subscriptions.broadcast({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
      }
    },
    async inject(fault: ServerFault) {
      rebuild(withFault(fixture, fault));
    },
    async emit(notification: JSONRPCNotification) {
      subscriptions.broadcast(notification);
    },
    mcpServerEntry: (): McpServerEntry => ({ type: "http", url }),
    async kill() {
      crash();
      await closeServer();
    },
    async restart() {
      if (!down) crash();
      await closeServer();
      counters = new WeakMap();
      handler = createHandler(fixture, { counters });
      server = createServer((req, res) => void handle(req, res));
      track(server);
      server.listen(port, host);
      await once(server, "listening");
      down = false;
      recorder.event({ kind: "restart" });
    },
    async stop() {
      subscriptions.endAll(true);
      for (const controller of inFlight) controller.abort();
      down = true;
      await closeServer();
    },
    async [Symbol.asyncDispose]() {
      await upstream.stop();
    },
  };
  return upstream;
}

/** Local origins are always allowed; anything else must be listed. Absent Origin is fine (non-browser client). */
function originAllowed(
  origin: string | undefined,
  allowed: readonly string[] = [],
): boolean {
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
