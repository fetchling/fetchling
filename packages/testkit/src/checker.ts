import { isObject, metaValue } from "./json.js";
import { META } from "./meta.js";

export type Severity = "error" | "warning";

export interface Violation {
  /** Stable id such as "id.uniqueInFlight": one rule per spec requirement. */
  rule: string;
  severity: Severity;
  /** Where the problem is, such as "result.ttlMs". Empty means the whole message. */
  path: string;
  message: string;
}

export interface StreamEntry {
  /** Relative to the server being observed: "in" was sent by its client. */
  direction: "in" | "out";
  message: unknown;
}

export interface CheckResponseOptions {
  /** resultType values added by extensions that both sides advertised. */
  extraResultTypes?: readonly string[];
}

const CACHEABLE_METHODS = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);
const CORE_RESULT_TYPES = new Set(["complete", "input_required"]);
const SPEC_ERROR_CODES = new Set([-32020, -32021, -32022]);
const RETIRED_ERROR_CODES = new Set([-32002, -32042]);

function violation(rule: string, path: string, message: string, severity: Severity = "error"): Violation {
  return { rule, severity, path, message };
}

/** Parse one wire frame and apply the rules every JSON-RPC message must follow. */
export function checkFrame(text: string): { message: unknown; violations: Violation[] } {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { message: undefined, violations: [violation("json.parse", "", "frame is not valid JSON")] };
  }
  const violations: Violation[] = [];
  if (!isObject(message)) {
    violations.push(violation("message.object", "", "message is not a JSON object"));
  } else {
    if (message.jsonrpc !== "2.0") violations.push(violation("jsonrpc.version", "jsonrpc", 'must be "2.0"'));
    if (message.id === null) violations.push(violation("id.nonNull", "id", "id must not be null"));
  }
  return { message, violations };
}

/** Rules for a client-to-server request. */
export function checkRequest(message: unknown): Violation[] {
  if (!isObject(message)) return [violation("message.object", "", "request is not a JSON object")];
  const violations: Violation[] = [];
  if (message.id === null) violations.push(violation("id.nonNull", "id", "request id must not be null"));
  if (typeof metaValue(message.params, META.protocolVersion) !== "string") {
    violations.push(
      violation("meta.protocolVersion", `params._meta.${META.protocolVersion}`, "required on every request"),
    );
  }
  if (!isObject(metaValue(message.params, META.clientCapabilities))) {
    violations.push(
      violation("meta.clientCapabilities", `params._meta.${META.clientCapabilities}`, "required on every request"),
    );
  }
  return violations;
}

/** Rules for a server's response to one specific request. */
export function checkResponse(
  request: { id: unknown; method: string },
  response: unknown,
  options: CheckResponseOptions = {},
): Violation[] {
  if (!isObject(response)) return [violation("message.object", "", "response is not a JSON object")];
  const violations: Violation[] = [];
  if (response.jsonrpc !== "2.0") violations.push(violation("jsonrpc.version", "jsonrpc", 'must be "2.0"'));
  if (response.id === null) {
    violations.push(violation("id.nonNull", "id", "response id must not be null"));
  } else if (response.id !== request.id) {
    violations.push(
      violation("id.matches", "id", `expected ${String(request.id)}, got ${String(response.id)}`),
    );
  }

  const hasResult = "result" in response;
  const hasError = "error" in response;
  if (hasResult === hasError) {
    violations.push(violation("response.resultXorError", "", "needs exactly one of result or error"));
    return violations;
  }
  if (hasError) return [...violations, ...checkError(response.error)];

  const result = response.result;
  if (!isObject(result)) return [...violations, violation("result.object", "result", "must be an object")];

  const resultType = result.resultType;
  if (typeof resultType !== "string") {
    violations.push(violation("result.resultType.present", "result.resultType", "required on every result"));
    return violations;
  }
  const allowed = options.extraResultTypes ?? [];
  if (!CORE_RESULT_TYPES.has(resultType) && !allowed.includes(resultType)) {
    violations.push(
      violation("result.resultType.known", "result.resultType", `unrecognised "${resultType}" is invalid`),
    );
  }
  if (resultType === "input_required" && result.inputRequests === undefined && result.requestState === undefined) {
    violations.push(violation("inputRequired.nonEmpty", "result", "needs inputRequests, requestState, or both"));
  }
  if (resultType === "complete" && CACHEABLE_METHODS.has(request.method)) {
    const { ttlMs, cacheScope } = result;
    if (typeof ttlMs !== "number" || ttlMs < 0) {
      violations.push(violation("cacheable.ttlMs", "result.ttlMs", `required non-negative number on ${request.method}`));
    }
    if (cacheScope !== "public" && cacheScope !== "private") {
      violations.push(violation("cacheable.cacheScope", "result.cacheScope", `required on ${request.method}`));
    }
  }
  if (!isObject(metaValue(result, META.serverInfo))) {
    violations.push(
      violation("result.serverInfo", `result._meta.${META.serverInfo}`, "servers SHOULD identify themselves", "warning"),
    );
  }
  return violations;
}

function checkError(error: unknown): Violation[] {
  if (!isObject(error)) return [violation("error.object", "error", "must be an object")];
  const violations: Violation[] = [];
  const { code, message } = error;
  if (typeof message !== "string") violations.push(violation("error.message", "error.message", "required string"));
  if (typeof code !== "number" || !Number.isInteger(code)) {
    violations.push(violation("error.code.integer", "error.code", "error codes must be integers"));
    return violations;
  }
  if (RETIRED_ERROR_CODES.has(code)) {
    violations.push(violation("error.retired", "error.code", `${code} is retired and must not be emitted`));
  } else if (code <= -32020 && code >= -32099 && !SPEC_ERROR_CODES.has(code)) {
    violations.push(violation("error.reservedRange", "error.code", `${code} is reserved for the MCP spec`));
  } else if (code <= -32000 && code >= -32019) {
    violations.push(
      violation("error.legacyRange", "error.code", `${code} is in the legacy range; avoid it`, "warning"),
    );
  }
  return violations;
}

/** Rules that only show up across a sequence of messages on one connection. */
export function checkStream(entries: readonly StreamEntry[]): Violation[] {
  const violations: Violation[] = [];
  const inFlight = new Set<string>();
  const acknowledged = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const message = entry.message;
    if (!isObject(message)) continue;
    const key = idKey(message.id);
    const hasMethod = typeof message.method === "string";

    if (key !== undefined && hasMethod && entry.direction === "in") {
      if (inFlight.has(key)) {
        violations.push(
          violation("id.uniqueInFlight", `[${index}].id`, `id ${String(message.id)} reused while still in flight`),
        );
      }
      inFlight.add(key);
    } else if (key !== undefined && !hasMethod && entry.direction === "out") {
      inFlight.delete(key);
    } else if (key === undefined && hasMethod && entry.direction === "out") {
      const subscription = metaValue(message.params, META.subscriptionId);
      const subscriptionKey = idKey(subscription);
      if (subscriptionKey === undefined) continue;
      if (message.method === "notifications/subscriptions/acknowledged") {
        acknowledged.add(subscriptionKey);
      } else if (!acknowledged.has(subscriptionKey)) {
        violations.push(
          violation(
            "subscription.ackFirst",
            `[${index}]`,
            `${String(message.method)} sent on subscription ${String(subscription)} before its acknowledgement`,
          ),
        );
      }
    }
  }
  return violations;
}

/** 1 and "1" are different JSON-RPC ids, so the key keeps the type. */
function idKey(id: unknown): string | undefined {
  if (typeof id === "number" || typeof id === "string") return `${typeof id}:${id}`;
  return undefined;
}