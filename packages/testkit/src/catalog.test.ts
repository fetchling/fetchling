import { describe, expect, it } from "vitest";
import { adversarialTools, generateCatalog } from "./catalog.js";
import { checkTool, checkToolList } from "./checker.js";

describe("generateCatalog", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = generateCatalog({ seed: 1, servers: 3, toolsPerServer: 10 });
    expect(generateCatalog({ seed: 1, servers: 3, toolsPerServer: 10 })).toEqual(a);
    expect(generateCatalog({ seed: 2, servers: 3, toolsPerServer: 10 })).not.toEqual(a);
  });

  it("builds the Phase 3 scale: 15 servers × 20 tools, unique within a server", () => {
    const catalog = generateCatalog({ seed: 42, servers: 15, toolsPerServer: 20 });
    expect(catalog).toHaveLength(15);
    for (const server of catalog) {
      const names = (server.tools ?? []).map((t) => t.tool.name);
      expect(names).toHaveLength(20);
      expect(new Set(names).size).toBe(20);
    }
    expect(new Set(catalog.map((s) => s.name)).size).toBe(15);
  });

  it("repeats tool names across servers, so namespacing (D1) is exercised", () => {
    const catalog = generateCatalog({ seed: 42, servers: 15, toolsPerServer: 20 });
    const all = catalog.flatMap((s) => (s.tools ?? []).map((t) => t.tool.name));
    expect(new Set(all).size).toBeLessThan(all.length);
  });

  it("produces only spec-clean tools in the realistic vocabulary", () => {
    for (const server of generateCatalog({
      seed: 7,
      servers: 15,
      toolsPerServer: 20,
    })) {
      expect(checkToolList((server.tools ?? []).map((t) => t.tool))).toEqual([]);
    }
  });
});

describe("adversarialTools", () => {
  it.each(
    adversarialTools().map((a) => ({ name: a.fixture.tool.name.slice(0, 40), a })),
  )("$name trips exactly the rule it claims", ({ a }) => {
    const rules = checkTool(a.fixture.tool).map((v) => v.rule);
    if (a.expectedRule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(a.expectedRule);
  });

  it("includes a duplicate name that checkToolList reports", () => {
    const rules = checkToolList(adversarialTools().map((a) => a.fixture.tool)).map(
      (v) => v.rule,
    );
    expect(rules).toContain("tool.name.unique");
  });
});
