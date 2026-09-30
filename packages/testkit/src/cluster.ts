import type { FakeUpstream, McpServerEntry } from "./fake.js";
import type { ServerFixture } from "./fixtures.js";
import { startHttp } from "./http-transport.js";
import { startStdio } from "./stdio-transport.js";

/** The `mcp.json` shape Claude Code, Cursor and fetchling (plan D8) read. */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface Cluster extends AsyncDisposable {
  /** Every fake, by fixture name. */
  readonly upstreams: Readonly<Record<string, FakeUpstream>>;
  /** One fake by name; throws if there is none (a typo should fail loudly). */
  get(name: string): FakeUpstream;
  /** A config pointing at every fake — feed it to fetchling to test its real config path. */
  mcpConfig(): McpConfig;
  stop(): Promise<void>;
}

export interface StartClusterOptions {
  /** "mixed" alternates stdio and HTTP in fixture order. Default "stdio" (like most real mcp.json files). */
  transport?: "stdio" | "http" | "mixed";
}

/** Start several fakes at once. Fixture names become the server names in mcpConfig(). */
export async function startCluster(
  fixtures: readonly ServerFixture[],
  options: StartClusterOptions = {},
): Promise<Cluster> {
  const names = new Set<string>();
  for (const fixture of fixtures) {
    if (names.has(fixture.name))
      throw new Error(`startCluster: duplicate fixture name "${fixture.name}"`);
    names.add(fixture.name);
  }
  const transport = options.transport ?? "stdio";
  const started: FakeUpstream[] = [];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const useHttp =
        transport === "http" || (transport === "mixed" && index % 2 === 1);
      started.push(useHttp ? await startHttp(fixture) : await startStdio(fixture));
    }
  } catch (error) {
    await Promise.allSettled(started.map((u) => u.stop()));
    throw error;
  }
  const upstreams = Object.fromEntries(started.map((u) => [u.name, u]));

  const cluster: Cluster = {
    upstreams,
    get(name) {
      const upstream = upstreams[name];
      if (!upstream)
        throw new Error(
          `No fake named "${name}" in this cluster (have: ${Object.keys(upstreams).join(", ")})`,
        );
      return upstream;
    },
    mcpConfig: () => ({
      mcpServers: Object.fromEntries(started.map((u) => [u.name, u.mcpServerEntry()])),
    }),
    async stop() {
      await Promise.allSettled(started.map((u) => u.stop()));
    },
    async [Symbol.asyncDispose]() {
      await cluster.stop();
    },
  };
  return cluster;
}
