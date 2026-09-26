import { describe, expect, it } from "vitest";
import {
  checkFrame,
  checkRequest,
  checkResponse,
  checkStream,
  type StreamEntry,
} from "./checker.js";

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);
const listTools = { id: 1, method: "tools/list" };
const serverInfo = {
  "io.modelcontextprotocol/serverInfo": { name: "fs", version: "1" },
};

describe("checkResponse", () => {
  it("accepts a complete, cacheable, identified result", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        tools: [],
        ttlMs: 0,
        cacheScope: "public",
        _meta: serverInfo,
      },
    };
    expect(checkResponse(listTools, response)).toEqual([]);
  });

  it("flags a missing resultType", () => {
    const response = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    expect(rules(checkResponse(listTools, response))).toContain(
      "result.resultType.present",
    );
  });

  it("flags missing cache fields on a cacheable method", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", tools: [], _meta: serverInfo },
    };
    expect(rules(checkResponse(listTools, response))).toEqual([
      "cacheable.ttlMs",
      "cacheable.cacheScope",
    ]);
  });

  it("treats an unknown resultType as invalid unless an extension allows it", () => {
    const call = { id: 1, method: "tools/call" };
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "banana", _meta: serverInfo },
    };
    expect(rules(checkResponse(call, response))).toContain("result.resultType.known");
    expect(
      rules(checkResponse(call, response, { extraResultTypes: ["banana"] })),
    ).toEqual([]);
  });

  it.each([
    { code: -32602, expected: [] },
    { code: -32021, expected: [] },
    { code: -31000, expected: [] },
    { code: -32050, expected: ["error.reservedRange"] },
    { code: -32002, expected: ["error.retired"] },
    { code: -32010, expected: ["error.legacyRange"] },
  ])("error code $code → $expected", ({ code, expected }) => {
    const response = { jsonrpc: "2.0", id: 1, error: { code, message: "x" } };
    expect(rules(checkResponse(listTools, response))).toEqual(expected);
  });
});

describe("checkRequest", () => {
  it("requires protocolVersion and clientCapabilities", () => {
    const req = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {} } };
    expect(rules(checkRequest(req))).toEqual([
      "meta.protocolVersion",
      "meta.clientCapabilities",
    ]);
  });
});

describe("checkFrame", () => {
  it("flags a frame that is not JSON", () => {
    expect(rules(checkFrame('{"jsonrpc":"2.0",').violations)).toEqual(["json.parse"]);
  });
});

describe("checkStream", () => {
  const req = (id: string | number): StreamEntry => ({
    direction: "in",
    message: { jsonrpc: "2.0", id, method: "tools/call", params: {} },
  });
  const res = (id: string | number): StreamEntry => ({
    direction: "out",
    message: { jsonrpc: "2.0", id, result: { resultType: "complete" } },
  });
  const note = (method: string): StreamEntry => ({
    direction: "out",
    message: {
      jsonrpc: "2.0",
      method,
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": 7 } },
    },
  });

  it("flags an id reused while the first request is still in flight", () => {
    expect(rules(checkStream([req(1), req(1)]))).toEqual(["id.uniqueInFlight"]);
  });

  it("allows reusing an id once its response has gone out", () => {
    expect(checkStream([req(1), res(1), req(1)])).toEqual([]);
  });

  it('treats 1 and "1" as different ids', () => {
    expect(checkStream([req(1), req("1")])).toEqual([]);
  });

  it("flags a subscription notification sent before the acknowledgement", () => {
    const early = [
      note("notifications/tools/list_changed"),
      note("notifications/subscriptions/acknowledged"),
    ];
    expect(rules(checkStream(early))).toEqual(["subscription.ackFirst"]);
    expect(checkStream([...early].reverse())).toEqual([]);
  });
});
