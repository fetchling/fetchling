import {
  type Implementation,
  type JSONRPCRequest,
  LATEST_PROTOCOL_VERSION,
  type RequestMetaObject,
} from "@fetchling/protocol";
import type { JsonObject } from "./json.js";

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;

export const TESTKIT_CLIENT: Implementation = { name: "fetchling-testkit", version: "0.0.0" };

/** A complete, valid request `_meta`. Override any key to see how a server reacts. */
export function meta(overrides: Partial<RequestMetaObject> = {}): RequestMetaObject {
  return {
    "io.modelcontextprotocol/protocolVersion": LATEST_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": TESTKIT_CLIENT,
    ...overrides,
  };
}

let nextId = 1;

/** A valid request with a fresh id and complete `_meta`. */
export function request(
  method: string,
  params: JsonObject = {},
  metaOverrides: Partial<RequestMetaObject> = {},
): JSONRPCRequest {
  const id = nextId;
  nextId += 1;
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta(metaOverrides) } };
}