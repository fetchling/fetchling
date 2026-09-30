import {
  type CompleteResult,
  type DiscoverResult,
  type Implementation,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LATEST_PROTOCOL_VERSION,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  type RequestId,
  type Result,
  type ServerCapabilities,
  type SubscriptionFilter,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "@fetchling/protocol";
import { runBehaviour, validateBehaviour } from "./behaviour.js";
import type { Behaviour, CachePolicy, ServerFault, ServerFixture } from "./fixtures.js";
import { isObject, type JsonObject, metaValue } from "./json.js";
import { META } from "./meta.js";
import { fail, notify, raw, reply, type Step } from "./steps.js";

export const DEFAULT_CACHE: CachePolicy = { ttlMs: 60_000, cacheScope: "public" };

export interface Handler {
  readonly fixture: ServerFixture;
  readonly capabilities: ServerCapabilities;
  /** Accepts anything a transport received; returns the script to play back. */
  handle(message: unknown): Step[];
}

export interface HandlerOptions {
  /**
   * Sequence counters to continue from. Transports pass the previous handler's map
   * when a fixture changes mid-test, so unchanged `sequence` behaviours keep counting.
   */
  counters?: WeakMap<Behaviour, number>;
}

/** Methods that only exist when the matching server capability is advertised. */
const CAPABILITY_GATES: Record<string, keyof ServerCapabilities> = {
  "tools/list": "tools",
  "tools/call": "tools",
  "prompts/list": "prompts",
  "prompts/get": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resources",
  "resources/read": "resources",
  "completion/complete": "completions",
};

// HTTP statuses the Streamable HTTP transport requires for specific errors.
const BAD_REQUEST = 400;
const NOT_FOUND = 404;

type Fault<K extends ServerFault["kind"]> = Extract<ServerFault, { kind: K }>;

export function createHandler(
  fixture: ServerFixture,
  options: HandlerOptions = {},
): Handler {
  for (const entry of fixture.tools ?? []) {
    validateBehaviour(entry.behaviour, `tool ${entry.tool.name}`);
  }
  for (const entry of fixture.prompts ?? []) {
    validateBehaviour(entry.behaviour, `prompt ${entry.prompt.name}`);
  }
  for (const entry of fixture.resources ?? []) {
    validateBehaviour(entry.behaviour, `resource ${entry.resource.uri}`);
  }
  if (
    fixture.pageSize !== undefined &&
    !(Number.isInteger(fixture.pageSize) && fixture.pageSize > 0)
  ) {
    throw new Error(`${fixture.name}: pageSize must be a positive integer`);
  }

  const capabilities = fixture.capabilities ?? deriveCapabilities(fixture);
  const cache = fixture.cache ?? DEFAULT_CACHE;
  const supportedVersions = fixture.supportedVersions ?? [LATEST_PROTOCOL_VERSION];
  const serverInfo: Implementation = {
    name: fixture.name,
    version: fixture.version ?? "0.0.0-testkit",
  };
  const counters = options.counters ?? new WeakMap<Behaviour, number>();
  let requestCount = 0;

  function fault<K extends ServerFault["kind"]>(kind: K): Fault<K> | undefined {
    return fixture.faults?.find((f): f is Fault<K> => f.kind === kind);
  }

  function handle(message: unknown): Step[] {
    if (!isObject(message) || typeof message.method !== "string") return []; // not a request
    const method = message.method;
    if (!("id" in message)) return []; // a notification: nothing to answer
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return [
        fail(
          undefined,
          INVALID_REQUEST,
          "Request id must be a string or a number, never null",
          undefined,
          BAD_REQUEST,
        ),
      ];
    }

    requestCount += 1;
    const dieAfter = fault("dieAfter");
    if (dieAfter && requestCount > dieAfter.requests)
      return [{ kind: "crash", exitCode: 1 }];

    const params = isObject(message.params) ? message.params : {};
    return dispatch(id, method, params).map(addServerInfo);
  }

  function dispatch(id: RequestId, method: string, params: JsonObject): Step[] {
    const version = metaValue(params, META.protocolVersion);
    const declared = metaValue(params, META.clientCapabilities);

    if (fixture.inbound !== "lenient") {
      const missing: string[] = [];
      if (typeof version !== "string") missing.push(META.protocolVersion);
      if (!isObject(declared)) missing.push(META.clientCapabilities);
      if (missing.length > 0) {
        return [
          fail(
            id,
            INVALID_PARAMS,
            `Missing required _meta: ${missing.join(", ")}`,
            undefined,
            BAD_REQUEST,
          ),
        ];
      }
    }
    if (typeof version === "string" && !supportedVersions.includes(version)) {
      return [
        fail(
          id,
          UNSUPPORTED_PROTOCOL_VERSION,
          `Unsupported protocol version ${version}`,
          { supported: supportedVersions, requested: version },
          BAD_REQUEST,
        ),
      ];
    }

    const clientCapabilities = isObject(declared) ? declared : {};
    const required = fault("requireCapability");
    if (required && method !== "server/discover") {
      const missing = Object.keys(required.capabilities).filter(
        (name) => !(name in clientCapabilities),
      );
      if (missing.length > 0) {
        return [
          fail(
            id,
            MISSING_REQUIRED_CLIENT_CAPABILITY,
            `Client did not declare: ${missing.join(", ")}`,
            { requiredCapabilities: required.capabilities },
            BAD_REQUEST,
          ),
        ];
      }
    }

    const gate = CAPABILITY_GATES[method];
    if (gate !== undefined && capabilities[gate] === undefined) {
      return [
        fail(
          id,
          METHOD_NOT_FOUND,
          `${method} is unavailable: "${gate}" is not advertised`,
          undefined,
          NOT_FOUND,
        ),
      ];
    }

    const behave = (behaviour: Behaviour): Step[] =>
      runBehaviour(behaviour, {
        id,
        method,
        params,
        request: { jsonrpc: "2.0", id, method, params },
        clientCapabilities,
        cache,
        counters,
      });

    switch (method) {
      case "server/discover": {
        const result: DiscoverResult = {
          resultType: "complete",
          supportedVersions,
          capabilities,
          ...(fixture.instructions === undefined
            ? {}
            : { instructions: fixture.instructions }),
          ...cache,
        };
        return cacheable(id, result);
      }
      case "tools/list": {
        const listed = page(
          (fixture.tools ?? []).map((entry) => entry.tool),
          params,
        );
        if (!listed) return [invalidCursor(id)];
        const result: ListToolsResult = {
          resultType: "complete",
          tools: listed.items,
          ...listed.next,
          ...cache,
        };
        return cacheable(id, result);
      }
      case "prompts/list": {
        const listed = page(
          (fixture.prompts ?? []).map((entry) => entry.prompt),
          params,
        );
        if (!listed) return [invalidCursor(id)];
        const result: ListPromptsResult = {
          resultType: "complete",
          prompts: listed.items,
          ...listed.next,
          ...cache,
        };
        return cacheable(id, result);
      }
      case "resources/list": {
        const listed = page(
          (fixture.resources ?? []).map((entry) => entry.resource),
          params,
        );
        if (!listed) return [invalidCursor(id)];
        const result: ListResourcesResult = {
          resultType: "complete",
          resources: listed.items,
          ...listed.next,
          ...cache,
        };
        return cacheable(id, result);
      }
      case "resources/templates/list": {
        const listed = page(fixture.resourceTemplates ?? [], params);
        if (!listed) return [invalidCursor(id)];
        const result: ListResourceTemplatesResult = {
          resultType: "complete",
          resourceTemplates: listed.items,
          ...listed.next,
          ...cache,
        };
        return cacheable(id, result);
      }
      case "tools/call": {
        const entry = fixture.tools?.find((t) => t.tool.name === params.name);
        if (!entry)
          return [fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`)];
        return behave(entry.behaviour);
      }
      case "prompts/get": {
        const entry = fixture.prompts?.find((p) => p.prompt.name === params.name);
        if (!entry)
          return [fail(id, INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`)];
        return behave(entry.behaviour);
      }
      case "resources/read": {
        const entry = fixture.resources?.find((r) => r.resource.uri === params.uri);
        if (!entry) {
          return [
            fail(id, INVALID_PARAMS, `Resource not found: ${String(params.uri)}`),
          ];
        }
        return behave(entry.behaviour);
      }
      case "completion/complete":
        return [reply(id, complete(params))];
      case "subscriptions/listen":
        return listen(id, params);
      default:
        return [
          fail(
            id,
            METHOD_NOT_FOUND,
            `Method not found: ${method}`,
            undefined,
            NOT_FOUND,
          ),
        ];
    }
  }

  /**
   * One page of a list. Cursors are opaque to clients (base64url of an offset here);
   * an unreadable or out-of-range cursor returns undefined, which becomes -32602.
   */
  function page<T>(
    items: readonly T[],
    params: JsonObject,
  ): { items: T[]; next: { nextCursor?: string } } | undefined {
    let offset = 0;
    if (params.cursor !== undefined) {
      if (typeof params.cursor !== "string") return undefined;
      const decoded = decodeCursor(params.cursor);
      if (decoded === undefined || decoded > items.length) return undefined;
      offset = decoded;
    }
    const size = fixture.pageSize ?? items.length;
    const end = offset + size;
    return {
      items: items.slice(offset, end),
      next: end < items.length ? { nextCursor: encodeCursor(end) } : {},
    };
  }

  function invalidCursor(id: RequestId): Step {
    return fail(id, INVALID_PARAMS, "Invalid cursor");
  }

  function cacheable(id: RequestId, result: Result): Step[] {
    if (!fault("omitCacheFields")) return [reply(id, result)];
    const stripped = Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== "ttlMs" && key !== "cacheScope"),
    );
    return [raw({ jsonrpc: "2.0", id, result: stripped })];
  }

  function complete(params: JsonObject): CompleteResult {
    const ref = isObject(params.ref) ? params.ref : {};
    const argument = isObject(params.argument) ? params.argument : {};
    const prefix = typeof argument.value === "string" ? argument.value : "";
    const entry = fixture.completions?.find(
      (c) =>
        c.argument === argument.name &&
        c.ref.type === ref.type &&
        (c.ref.type === "ref/prompt" ? c.ref.name === ref.name : c.ref.uri === ref.uri),
    );
    const values = (entry?.values ?? []).filter((value) => value.startsWith(prefix));
    return {
      resultType: "complete",
      completion: { values, total: values.length, hasMore: false },
    };
  }

  function listen(id: RequestId, params: JsonObject): Step[] {
    const requested = isObject(params.notifications) ? params.notifications : {};
    const honoured: SubscriptionFilter = {};
    if (requested.toolsListChanged === true && capabilities.tools?.listChanged) {
      honoured.toolsListChanged = true;
    }
    if (requested.promptsListChanged === true && capabilities.prompts?.listChanged) {
      honoured.promptsListChanged = true;
    }
    if (
      requested.resourcesListChanged === true &&
      capabilities.resources?.listChanged
    ) {
      honoured.resourcesListChanged = true;
    }
    if (
      Array.isArray(requested.resourceSubscriptions) &&
      capabilities.resources?.subscribe
    ) {
      honoured.resourceSubscriptions = requested.resourceSubscriptions.filter(
        (uri): uri is string => typeof uri === "string",
      );
    }

    const steps: Step[] = [];
    if (!fault("skipSubscriptionAck")) {
      steps.push(
        notify("notifications/subscriptions/acknowledged", {
          notifications: honoured,
          _meta: { "io.modelcontextprotocol/subscriptionId": id },
        }),
      );
    }
    // Tells the transport to register this stream, so later notifications reach it.
    steps.push({ kind: "subscribe", subscriptionId: id, filter: honoured });
    // The listen response only arrives when the stream closes, so the request stays open.
    steps.push({ kind: "hang" });
    return steps;
  }

  function addServerInfo(step: Step): Step {
    if (step.kind !== "send" || fault("noServerInfo")) return step;
    const message = step.message;
    if (!("result" in message)) return step;
    return {
      ...step,
      message: {
        ...message,
        result: {
          ...message.result,
          _meta: {
            ...message.result._meta,
            "io.modelcontextprotocol/serverInfo": serverInfo,
          },
        },
      },
    };
  }

  return { fixture, capabilities, handle };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!isObject(parsed)) return undefined;
    const { offset } = parsed;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0
      ? offset
      : undefined;
  } catch {
    return undefined;
  }
}

/** Capabilities a fixture implies when it doesn't declare its own. */
export function deriveCapabilities(fixture: ServerFixture): ServerCapabilities {
  const capabilities: ServerCapabilities = {};
  if (fixture.tools?.length) capabilities.tools = { listChanged: true };
  if (fixture.prompts?.length) capabilities.prompts = { listChanged: true };
  if (fixture.resources?.length || fixture.resourceTemplates?.length) {
    capabilities.resources = { subscribe: true, listChanged: true };
  }
  if (fixture.completions?.length) capabilities.completions = {};
  return capabilities;
}
