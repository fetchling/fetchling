import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCNotification,
  RequestId,
  Result,
} from "@fetchling/protocol";

/**
 * One instruction for a transport. The handler returns a list of these and never does
 * I/O itself, which is what makes it testable with plain function calls.
 */
export type Step =
  | { kind: "send"; message: JSONRPCMessage }
  | { kind: "sendRaw"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "crash"; exitCode: number }
  | { kind: "hang" };

export function reply(id: RequestId, result: Result): Step {
  return { kind: "send", message: { jsonrpc: "2.0", id, result } };
}

export function fail(
  id: RequestId | undefined,
  code: number,
  message: string,
  data?: unknown,
): Step {
  const response: JSONRPCErrorResponse = {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
  return { kind: "send", message: response };
}

export function notify(method: string, params: Record<string, unknown>): Step {
  const notification: JSONRPCNotification = { jsonrpc: "2.0", method, params };
  return { kind: "send", message: notification };
}

/** For deliberately broken output: a string goes out as-is, anything else via JSON.stringify. */
export function raw(value: unknown): Step {
  return { kind: "sendRaw", text: typeof value === "string" ? value : JSON.stringify(value) };
}