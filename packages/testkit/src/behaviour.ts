import {
  type CallToolResult,
  type GetPromptResult,
  INTERNAL_ERROR,
  type InputRequests,
  type InputRequiredResult,
  type JSONRPCRequest,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  type ReadResourceResult,
  type RequestId,
  type Result,
} from "@fetchling/protocol";
import type {
  Behaviour,
  CachePolicy,
  InputRequiredBehaviour,
  LoadShedBehaviour,
  MalformedMode,
} from "./fixtures.js";
import { getPath, isObject, type JsonObject, jsonEqual, metaValue } from "./json.js";
import { fail, notify, raw, reply, type Step } from "./steps.js";

export interface BehaviourContext {
  readonly id: RequestId;
  /** "tools/call", "prompts/get" or "resources/read". */
  readonly method: string;
  readonly params: JsonObject;
  readonly request: JSONRPCRequest;
  readonly clientCapabilities: JsonObject;
  readonly cache: CachePolicy;
  /** How often each sequence node has run. Keyed by the node object itself. */
  readonly counters: WeakMap<Behaviour, number>;
}

export function runBehaviour(behaviour: Behaviour, ctx: BehaviourContext): Step[] {
  return run(startingPoint(behaviour, ctx.params), ctx);
}

/**
 * Multi round-trip without server state: walk the chain of `next` links and start after
 * the deepest input stage this retry satisfies. A first call satisfies nothing and starts
 * at the top; a retry answering stage 2 skips stage 1.
 */
function startingPoint(behaviour: Behaviour, params: JsonObject): Behaviour {
  let start = behaviour;
  let node = behaviour;
  while ("next" in node) {
    if ((node.kind === "inputRequired" || node.kind === "loadShed") && isSatisfied(node, params)) {
      start = node.next;
    }
    node = node.next;
  }
  return start;
}

function isSatisfied(
  node: InputRequiredBehaviour | LoadShedBehaviour,
  params: JsonObject,
): boolean {
  if (node.requestState !== undefined && params.requestState !== node.requestState) return false;
  if (node.kind === "loadShed") return true;
  if (node.inputRequests === undefined) return node.requestState !== undefined;
  const responses = params.inputResponses;
  if (!isObject(responses)) return false;
  return Object.keys(node.inputRequests).every((key) => key in responses);
}

function run(b: Behaviour, ctx: BehaviourContext): Step[] {
  switch (b.kind) {
    case "respond":
      return [reply(ctx.id, b.result)];
    case "echo":
      return [reply(ctx.id, echoResult(ctx))];
    case "toolError": {
      if (ctx.method !== "tools/call") {
        return [fail(ctx.id, INTERNAL_ERROR, `toolError only applies to tools/call, not ${ctx.method}`)];
      }
      const result: CallToolResult = {
        resultType: "complete",
        content: [{ type: "text", text: b.message }],
        isError: true,
      };
      return [reply(ctx.id, result)];
    }
    case "protocolError":
      return [fail(ctx.id, b.code, b.message, b.data)];
    case "inputRequired":
      return inputRequired(b, ctx);
    case "loadShed": {
      const result: InputRequiredResult = {
        resultType: "input_required",
        requestState: b.requestState,
      };
      return [reply(ctx.id, result)];
    }
    case "delay":
      return [{ kind: "wait", ms: b.ms }, ...run(b.next, ctx)];
    case "progress":
      return [...progressSteps(b.steps, b.intervalMs, ctx), ...run(b.next, ctx)];
    case "hang":
      return [{ kind: "hang" }];
    case "sequence": {
      const calls = ctx.counters.get(b) ?? 0;
      ctx.counters.set(b, calls + 1);
      const step = b.steps[calls] ?? b.after ?? b.steps.at(-1);
      if (step === undefined) return [fail(ctx.id, INTERNAL_ERROR, "sequence has no steps")];
      return run(step, ctx);
    }
    case "match": {
      const hit = b.cases.find((c) => jsonEqual(getPath(ctx.params, c.when.path), c.when.equals));
      return run(hit ? hit.behaviour : b.otherwise, ctx);
    }
    case "malformed":
      return malformed(b.mode, ctx);
    case "crash":
      return [{ kind: "crash", exitCode: b.exitCode ?? 1 }];
    case "custom":
      return run(b.fn(ctx.request), ctx);
    default: {
      const unhandled: never = b;
      throw new Error(`Unknown behaviour: ${JSON.stringify(unhandled)}`);
    }
  }
}

const CAPABILITY_FOR_INPUT: Record<string, string> = {
  "elicitation/create": "elicitation",
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
};

function inputRequired(b: InputRequiredBehaviour, ctx: BehaviourContext): Step[] {
  const missing = missingCapabilities(b.inputRequests, ctx.clientCapabilities);
  if (missing.length > 0) {
    return [
      fail(ctx.id, MISSING_REQUIRED_CLIENT_CAPABILITY, `Client did not declare: ${missing.join(", ")}`, {
        requiredCapabilities: Object.fromEntries(missing.map((name) => [name, {}])),
      }),
    ];
  }
  const result: InputRequiredResult = {
    resultType: "input_required",
    ...(b.inputRequests === undefined ? {} : { inputRequests: b.inputRequests }),
    ...(b.requestState === undefined ? {} : { requestState: b.requestState }),
  };
  return [reply(ctx.id, result)];
}

function missingCapabilities(requests: InputRequests | undefined, declared: JsonObject): string[] {
  if (requests === undefined) return [];
  const needed = new Set<string>();
  for (const input of Object.values(requests)) {
    const capability = CAPABILITY_FOR_INPUT[input.method];
    if (capability !== undefined) needed.add(capability);
  }
  return [...needed].filter((name) => !(name in declared));
}

function progressSteps(steps: number, intervalMs: number, ctx: BehaviourContext): Step[] {
  const token = metaValue(ctx.params, "progressToken");
  const out: Step[] = [];
  for (let i = 1; i <= steps; i++) {
    out.push({ kind: "wait", ms: intervalMs });
    // Progress is opt-in: without a token the client asked for none, so send none.
    if (typeof token === "string" || typeof token === "number") {
      out.push(notify("notifications/progress", { progressToken: token, progress: i, total: steps }));
    }
  }
  return out;
}

function echoResult(ctx: BehaviourContext): Result {
  const args = isObject(ctx.params.arguments) ? ctx.params.arguments : {};
  switch (ctx.method) {
    case "tools/call": {
      const result: CallToolResult = {
        resultType: "complete",
        content: [{ type: "text", text: JSON.stringify(args) }],
        structuredContent: args,
      };
      return result;
    }
    case "prompts/get": {
      const result: GetPromptResult = {
        resultType: "complete",
        messages: [{ role: "user", content: { type: "text", text: JSON.stringify(args) } }],
      };
      return result;
    }
    default: {
      const uri = typeof ctx.params.uri === "string" ? ctx.params.uri : "";
      const result: ReadResourceResult = {
        resultType: "complete",
        contents: [{ uri, text: uri }],
        ttlMs: ctx.cache.ttlMs,
        cacheScope: ctx.cache.cacheScope,
      };
      return result;
    }
  }
}

function malformed(mode: MalformedMode, ctx: BehaviourContext): Step[] {
  const ok = echoResult(ctx);
  switch (mode) {
    case "invalidJson":
      return [raw(`{"jsonrpc":"2.0","id":${JSON.stringify(ctx.id)},"result":{`)];
    case "missingResultType": {
      const stripped = Object.fromEntries(
        Object.entries(ok).filter(([key]) => key !== "resultType"),
      );
      return [raw({ jsonrpc: "2.0", id: ctx.id, result: stripped })];
    }
    case "unknownResultType":
      return [reply(ctx.id, { ...ok, resultType: "banana" })];
    case "nullId":
      return [raw({ jsonrpc: "2.0", id: null, result: ok })];
    case "wrongId":
      return [reply(`${String(ctx.id)}-wrong`, ok)];
    case "duplicateResponse":
      return [reply(ctx.id, ok), reply(ctx.id, ok)];
    case "notificationFlood":
      return [
        ...Array.from({ length: 3 }, () =>
          notify("notifications/message", { level: "info", data: "unrequested log message" }),
        ),
        reply(ctx.id, ok),
      ];
    case "legacyErrorCode":
      return [fail(ctx.id, -32002, "Resource not found")];
    default: {
      const unhandled: never = mode;
      throw new Error(`Unknown malformed mode: ${String(unhandled)}`);
    }
  }
}

/** Reject fixtures the spec says are impossible, at startup rather than mid-test. */
export function validateBehaviour(behaviour: Behaviour, path: string): void {
  if (
    behaviour.kind === "inputRequired" &&
    behaviour.inputRequests === undefined &&
    behaviour.requestState === undefined
  ) {
    throw new Error(`${path}: inputRequired needs inputRequests, requestState, or both`);
  }
  if (behaviour.kind === "sequence") {
    for (const [i, step] of behaviour.steps.entries()) validateBehaviour(step, `${path}.steps[${i}]`);
    if (behaviour.after) validateBehaviour(behaviour.after, `${path}.after`);
  }
  if (behaviour.kind === "match") {
    for (const [i, c] of behaviour.cases.entries()) {
      validateBehaviour(c.behaviour, `${path}.cases[${i}]`);
    }
    validateBehaviour(behaviour.otherwise, `${path}.otherwise`);
  }
  if ("next" in behaviour) validateBehaviour(behaviour.next, `${path}.next`);
}