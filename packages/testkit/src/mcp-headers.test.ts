import type { Tool } from "@fetchling/protocol";
import { describe, expect, it } from "vitest";
import { adversarialTools } from "./catalog.js";
import {
  checkRequestHeaders,
  decodeHeaderValue,
  encodeHeaderValue,
  requestHeaders,
  scanParamHeaders,
} from "./mcp-headers.js";
import { request } from "./meta.js";

// The spec's own example tool (streamable-http.md § Custom Headers from Tool Parameters).
const executeSql: Tool = {
  name: "execute_sql",
  description: "Execute SQL on Google Cloud Spanner",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
    },
    required: ["region", "query"],
  },
};

describe("value encoding", () => {
  // Every row of the table in streamable-http.md § Value Encoding.
  it.each([
    { value: "us-west1", encoded: "us-west1" },
    { value: "Hello, 世界", encoded: "=?base64?SGVsbG8sIOS4lueVjA==?=" },
    { value: " padded ", encoded: "=?base64?IHBhZGRlZCA=?=" },
    { value: "line1\nline2", encoded: "=?base64?bGluZTEKbGluZTI=?=" },
    { value: "=?base64?literal?=", encoded: "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=" },
  ])("encodes $value as the spec's table says", ({ value, encoded }) => {
    expect(encodeHeaderValue(value)).toBe(encoded);
    expect(decodeHeaderValue(encoded)).toEqual({ ok: true, value });
  });

  it("rejects malformed Base64 and control characters when decoding", () => {
    expect(decodeHeaderValue("=?base64?not base64!?=").ok).toBe(false);
    expect(decodeHeaderValue("bad\u0001value").ok).toBe(false);
  });
});

describe("x-mcp-header validation", () => {
  it("accepts the spec's example and records the property path", () => {
    expect(scanParamHeaders(executeSql.inputSchema)).toEqual({
      ok: true,
      params: [{ name: "Region", path: ["region"], type: "string" }],
    });
  });

  // Each adversarial tool states which rule it trips; the scan must agree.
  it.each(
    adversarialTools().map((a) => ({
      name: a.fixture.tool.name,
      expectedRule: a.expectedRule,
      schema: a.fixture.tool.inputSchema,
    })),
  )("$name", ({ expectedRule, schema }) => {
    const scan = scanParamHeaders(schema);
    expect(scan.ok).toBe(expectedRule !== "tool.xMcpHeader.valid");
  });

  it("allows nested properties when every step is a properties key", () => {
    const scan = scanParamHeaders({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Region" } },
        },
      },
    });
    expect(scan).toMatchObject({ ok: true, params: [{ path: ["outer", "region"] }] });
  });

  it("does not mistake a parameter literally named x-mcp-header for a marker", () => {
    const scan = scanParamHeaders({
      type: "object",
      properties: { "x-mcp-header": { type: "string" } },
    });
    expect(scan).toEqual({ ok: true, params: [] });
  });
});

describe("building request headers", () => {
  it("derives every standard header and mirrors marked arguments", () => {
    const req = request("tools/call", {
      name: "execute_sql",
      arguments: { region: "us-west1", query: "SELECT 1" },
    });
    expect(requestHeaders(req, executeSql)).toEqual({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "execute_sql",
      "mcp-param-region": "us-west1",
    });
  });

  it("omits a param header when the argument is null or absent", () => {
    const withNull = request("tools/call", {
      name: "execute_sql",
      arguments: { region: null },
    });
    const absent = request("tools/call", { name: "execute_sql", arguments: {} });
    expect(requestHeaders(withNull, executeSql)).not.toHaveProperty("mcp-param-region");
    expect(requestHeaders(absent, executeSql)).not.toHaveProperty("mcp-param-region");
  });

  it("uses the URI as Mcp-Name for resources/read and encodes it when unsafe", () => {
    expect(
      requestHeaders(request("resources/read", { uri: "file:///a b" }))["mcp-name"],
    ).toBe("file:///a b");
    expect(
      requestHeaders(request("resources/read", { uri: "file:///ä" }))["mcp-name"],
    ).toMatch(/^=\?base64\?/);
  });
});

describe("server-side header validation", () => {
  const call = (args: Record<string, unknown>) =>
    request("tools/call", { name: "execute_sql", arguments: args });

  it("accepts headers that match the body", () => {
    const req = call({ region: "us-west1", query: "q" });
    expect(
      checkRequestHeaders(requestHeaders(req, executeSql), req, executeSql),
    ).toEqual({ ok: true });
  });

  it("rejects an Mcp-Name that disagrees with the body", () => {
    const req = call({ region: "us-west1" });
    const headers = { ...requestHeaders(req, executeSql), "mcp-name": "drop_table" };
    expect(checkRequestHeaders(headers, req, executeSql)).toMatchObject({ ok: false });
  });

  it("rejects a missing param header when the body has the value", () => {
    const req = call({ region: "us-west1" });
    const { "mcp-param-region": _dropped, ...headers } = requestHeaders(
      req,
      executeSql,
    );
    expect(checkRequestHeaders(headers, req, executeSql)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing"),
    });
  });

  it("rejects a param header when the body has no value", () => {
    const req = call({});
    const headers = {
      ...requestHeaders(req, executeSql),
      "mcp-param-region": "us-west1",
    };
    expect(checkRequestHeaders(headers, req, executeSql).ok).toBe(false);
  });

  it("compares integers numerically, so 42.0 matches 42", () => {
    const tool = {
      inputSchema: {
        type: "object" as const,
        properties: { n: { type: "integer", "x-mcp-header": "N" } },
      },
    };
    const req = request("tools/call", { name: "t", arguments: { n: 42 } });
    const headers = { ...requestHeaders(req, tool), "mcp-param-n": "42.0" };
    expect(checkRequestHeaders(headers, req, tool)).toEqual({ ok: true });
  });

  it("decodes a Base64 Mcp-Name before comparing", () => {
    const req = request("prompts/get", { name: "grüße" });
    expect(checkRequestHeaders(requestHeaders(req), req)).toEqual({ ok: true });
  });

  it("requires MCP-Protocol-Version to equal the body's _meta version", () => {
    const req = request("tools/list");
    const headers = { ...requestHeaders(req), "mcp-protocol-version": "2025-11-25" };
    expect(checkRequestHeaders(headers, req).ok).toBe(false);
  });
});
