import { describe, expect, it } from "vitest";
import { createSseParser, SSE_KEEP_ALIVE, sseEvent } from "./sse.js";

describe("SSE framing", () => {
  it("round-trips an event", () => {
    const parser = createSseParser();
    expect(parser.push(sseEvent('{"a":1}'))).toEqual(['{"a":1}']);
  });

  it("ignores keep-alive comments, as clients must", () => {
    const parser = createSseParser();
    expect(parser.push(`${SSE_KEEP_ALIVE}${sseEvent("x")}:\r\n\r\n`)).toEqual(["x"]);
  });

  it("reassembles events split across chunks and line-ending styles", () => {
    const parser = createSseParser();
    expect(parser.push("data: fir")).toEqual([]);
    expect(parser.push("st\r")).toEqual([]);
    expect(parser.push("\n\r\ndata: second\n\n")).toEqual(["first", "second"]);
  });

  it("joins multi-line data with newlines and flushes a trailing event", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\ndata: b\n")).toEqual([]);
    expect(parser.flush()).toEqual(["a\nb"]);
  });
});
