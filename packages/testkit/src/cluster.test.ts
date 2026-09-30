import { afterEach, describe, expect, it } from "vitest";
import { generateCatalog } from "./catalog.js";
import { type Cluster, startCluster } from "./cluster.js";
import { rawClient } from "./raw-client.js";

let cluster: Cluster | undefined;
afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

describe("startCluster", () => {
  it("starts mixed transports and describes them as an mcp.json", async () => {
    const fixtures = generateCatalog({ seed: 1, servers: 2, toolsPerServer: 3 });
    cluster = await startCluster(fixtures, { transport: "mixed" });
    const config = cluster.mcpConfig();
    expect(config.mcpServers.filesystem).toMatchObject({ command: process.execPath });
    expect(config.mcpServers.github).toMatchObject({
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
    });

    for (const name of ["filesystem", "github"]) {
      const client = rawClient(cluster.get(name));
      const exchange = await client.request("tools/list");
      expect(
        (exchange.response as { result: { tools: unknown[] } }).result.tools,
      ).toHaveLength(3);
      await client.close();
    }
  });

  it("rejects duplicate names and unknown lookups loudly", async () => {
    const [one] = generateCatalog({ seed: 1, servers: 1, toolsPerServer: 1 });
    if (!one) throw new Error("catalog is empty");
    await expect(startCluster([one, one])).rejects.toThrow(/duplicate/);
    cluster = await startCluster([one], { transport: "http" });
    expect(() => cluster?.get("typo")).toThrow(/No fake named "typo"/);
  });
});
