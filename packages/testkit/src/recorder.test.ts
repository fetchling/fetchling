import { describe, expect, it } from "vitest";
import { checkStream } from "./checker.js";
import { createRecorder, diffTraffic } from "./recorder.js";

const call = (id: number, client: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: client, version: "1" },
    },
  },
});
const list = (id: number, ttlMs: number) => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", tools: [], ttlMs, cacheScope: "public" },
});

describe("diffTraffic", () => {
  it("treats conversations that differ only in ids and client identity as equal", () => {
    const direct = [call(1, "claude-code"), list(1, 1000)];
    const proxied = [call(7, "fetchling"), list(7, 1000)];
    expect(diffTraffic(direct, proxied)).toEqual({ equal: true, differences: [] });
  });

  it("reports a real difference with a JSON Pointer", () => {
    const diff = diffTraffic([list(1, 1000)], [list(1, 0)]);
    expect(diff.equal).toBe(false);
    expect(diff.differences).toEqual([
      { index: 0, path: "/result/ttlMs", a: 1000, b: 0 },
    ]);
  });

  it("reports a missing message", () => {
    expect(
      diffTraffic([call(1, "a"), list(1, 1)], [call(1, "a")]).differences,
    ).toMatchObject([{ index: 1, path: "" }]);
  });

  it("accepts recorded frames as well as plain messages", () => {
    const recorder = createRecorder();
    recorder.frame({ direction: "in", raw: JSON.stringify(call(1, "a")) });
    expect(diffTraffic(recorder.frames(), [call(2, "b")]).equal).toBe(true);
  });
});

describe("recorder", () => {
  it("keeps a total order and parses messages", () => {
    const recorder = createRecorder();
    recorder.frame({ direction: "in", raw: JSON.stringify(call(1, "a")) });
    recorder.event({ kind: "cancelled" });
    recorder.frame({ direction: "out", raw: "not json" });
    const [first, second] = recorder.frames();
    expect(first?.seq).toBeLessThan(second?.seq ?? 0);
    expect(second?.message).toBeNull();
    expect(recorder.requests({ method: "tools/list" })).toHaveLength(1);
  });

  it("waitFor resolves for frames recorded later, and times out otherwise", async () => {
    const recorder = createRecorder();
    const waiting = recorder.waitFor({ method: "tools/list" });
    recorder.frame({ direction: "in", raw: JSON.stringify(call(1, "a")) });
    await expect(waiting).resolves.toMatchObject({ direction: "in" });
    await expect(
      recorder.waitFor({ method: "nope" }, { timeoutMs: 20 }),
    ).rejects.toThrow(/Timed out/);
  });

  it("feeds checkStream directly", () => {
    const recorder = createRecorder();
    recorder.frame({ direction: "in", raw: JSON.stringify(call(1, "a")) });
    recorder.frame({ direction: "in", raw: JSON.stringify(call(1, "b")) });
    expect(checkStream(recorder.stream()).map((v) => v.rule)).toEqual([
      "id.uniqueInFlight",
    ]);
  });
});
