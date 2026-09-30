import { describe, expect, it } from "vitest";
import {
  checkFrame,
  checkHttpExchange,
  checkRequest,
  checkResponse,
  checkStream,
  checkTool,
  checkToolList,
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

describe("checkResponse — rules from the pattern and caching pages", () => {
  const ok = { "io.modelcontextprotocol/serverInfo": { name: "fs", version: "1" } };

  it("requires ttlMs to be an integer", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        tools: [],
        ttlMs: 1.5,
        cacheScope: "public",
        _meta: ok,
      },
    };
    expect(rules(checkResponse(listTools, response))).toEqual(["cacheable.ttlMs"]);
  });

  it("allows input_required only on tools/call, prompts/get and resources/read", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "input_required", requestState: "s", _meta: ok },
    };
    expect(rules(checkResponse(listTools, response))).toContain(
      "inputRequired.allowedMethod",
    );
    expect(checkResponse({ id: 1, method: "tools/call" }, response)).toEqual([]);
  });
});

describe("checkTool", () => {
  it("accepts a plain tool", () => {
    expect(checkTool({ name: "read_file", inputSchema: { type: "object" } })).toEqual(
      [],
    );
  });

  it("warns on names outside the recommended length and charset", () => {
    expect(
      rules(checkTool({ name: "a".repeat(129), inputSchema: { type: "object" } })),
    ).toEqual(["tool.name.length"]);
    expect(
      rules(checkTool({ name: "read file", inputSchema: { type: "object" } })),
    ).toEqual(["tool.name.charset"]);
  });

  it("requires an object input schema", () => {
    expect(rules(checkTool({ name: "t", inputSchema: null }))).toEqual([
      "tool.inputSchema.object",
    ]);
  });

  it("flags an invalid x-mcp-header", () => {
    const tool = {
      name: "t",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number", "x-mcp-header": "N" } },
      },
    };
    expect(rules(checkTool(tool))).toEqual(["tool.xMcpHeader.valid"]);
  });

  it("flags duplicate names across a list", () => {
    const tool = { name: "t", inputSchema: { type: "object" } };
    expect(rules(checkToolList([tool, tool]))).toEqual(["tool.name.unique"]);
  });
});

describe("checkHttpExchange", () => {
  const post = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const good = {
    requestHeaders: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    request: post,
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    messages: [{ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }],
  };

  it("accepts a conforming exchange", () => {
    expect(checkHttpExchange(good)).toEqual([]);
  });

  it("requires the client to accept both JSON and SSE", () => {
    expect(
      rules(
        checkHttpExchange({
          ...good,
          requestHeaders: { ...good.requestHeaders, accept: "application/json" },
        }),
      ),
    ).toEqual(["http.accept"]);
  });

  it("requires 404 for method-not-found and 400 for header mismatch", () => {
    const notFound = {
      ...good,
      messages: [{ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } }],
    };
    expect(rules(checkHttpExchange(notFound))).toEqual(["http.status"]);
    expect(checkHttpExchange({ ...notFound, status: 404 })).toEqual([]);
    const mismatch = {
      ...good,
      status: 200,
      messages: [{ jsonrpc: "2.0", id: 1, error: { code: -32020, message: "x" } }],
    };
    expect(rules(checkHttpExchange(mismatch))).toEqual(["http.status"]);
  });

  it("expects 202 for an accepted notification", () => {
    const note = {
      ...good,
      request: { jsonrpc: "2.0", method: "notifications/x" },
      status: 200,
      messages: [],
    };
    expect(rules(checkHttpExchange(note))).toEqual(["http.status.notification"]);
  });
});
