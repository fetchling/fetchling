import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCNotification,
  RequestId,
  Result,
  SubscriptionFilter,
} from "@fetchling/protocol";

/**
 * One instruction for a transport. The handler returns a list of these and never does
 * I/O itself, which is what makes it testable with plain function calls. Transports
 * (HTTP, stdio) play the list back; see player.ts.
 */
export type Step =
  | {
      kind: "send";
      message: JSONRPCMessage;
      /** HTTP only: the status this message must be sent with (e.g. 400, 404). */
      httpStatus?: number;
    }
  | { kind: "sendRaw"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "crash"; exitCode: number }
  | {
      kind: "subscribe";
      /** The JSON-RPC id of the subscriptions/listen request. */
      subscriptionId: RequestId;
      /** What the server agreed to deliver on this stream. */
      filter: SubscriptionFilter;
    }
  | { kind: "hang" };

export type SendStep = Extract<Step, { kind: "send" }>;
export type RawStep = Extract<Step, { kind: "sendRaw" }>;
export type SubscribeStep = Extract<Step, { kind: "subscribe" }>;

export function reply(id: RequestId, result: Result): Step {
  return { kind: "send", message: { jsonrpc: "2.0", id, result } };
}

export function fail(
  id: RequestId | undefined,
  code: number,
  message: string,
  data?: unknown,
  httpStatus?: number,
): Step {
  const response: JSONRPCErrorResponse = {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
  return {
    kind: "send",
    message: response,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

export function notify(method: string, params: Record<string, unknown>): Step {
  const notification: JSONRPCNotification = { jsonrpc: "2.0", method, params };
  return { kind: "send", message: notification };
}

/** For deliberately broken output: a string goes out as-is, anything else via JSON.stringify. */
export function raw(value: unknown): Step {
  return {
    kind: "sendRaw",
    text: typeof value === "string" ? value : JSON.stringify(value),
  };
}

/** True for a message that answers a request (has an id and a result or error). */
export function isResponse(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    !("method" in message) &&
    ("result" in message || "error" in message)
  );
}
