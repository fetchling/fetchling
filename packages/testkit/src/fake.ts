import type { JSONRPCNotification, Tool } from "@fetchling/protocol";
import type { Behaviour, ServerFault, ServerFixture, ToolFixture } from "./fixtures.js";
import type { Traffic } from "./recorder.js";

/** Which primitive a behaviour change applies to. */
export type Target = { tool: string } | { prompt: string } | { resource: string };

/** How an mcp.json-style config refers to a server (the shape Claude Code and Cursor read). */
export type McpServerEntry =
  | { command: string; args: string[] }
  | { type: "http"; url: string };

/**
 * A running fake upstream MCP server, whatever its transport. Every control method is
 * async because on stdio it crosses a process boundary.
 */
export interface FakeUpstream extends AsyncDisposable {
  readonly name: string;
  readonly transport: "stdio" | "http";
  /** Everything the fake received and sent, in order. */
  readonly traffic: Traffic;
  /** The fixture currently in force. */
  fixture(): ServerFixture;
  /** Replace one tool's, prompt's or resource's behaviour. Unchanged `sequence` behaviours keep counting on HTTP. */
  setBehaviour(target: Target, behaviour: Behaviour): Promise<void>;
  /** Replace the tool set. Subscribers that asked for toolsListChanged are notified. */
  setTools(tools: ToolFixture[]): Promise<void>;
  /** Add a server-level fault. */
  inject(fault: ServerFault): Promise<void>;
  /** Push a change notification to every open subscription that asked for it. */
  emit(notification: JSONRPCNotification): Promise<void>;
  /** This server as an entry in an mcp.json `mcpServers` map. */
  mcpServerEntry(): McpServerEntry;
  /** Graceful shutdown: subscriptions end with a final response, then everything closes. */
  stop(): Promise<void>;
}

// ── fixture edits (pure: they return a new fixture) ──────────────────────────────

export function withBehaviour(
  fixture: ServerFixture,
  target: Target,
  behaviour: Behaviour,
): ServerFixture {
  if ("tool" in target) {
    assertFound(
      fixture.tools?.some((t) => t.tool.name === target.tool),
      `tool "${target.tool}"`,
      fixture,
    );
    return {
      ...fixture,
      tools: (fixture.tools ?? []).map((t) =>
        t.tool.name === target.tool ? { ...t, behaviour } : t,
      ),
    };
  }
  if ("prompt" in target) {
    assertFound(
      fixture.prompts?.some((p) => p.prompt.name === target.prompt),
      `prompt "${target.prompt}"`,
      fixture,
    );
    return {
      ...fixture,
      prompts: (fixture.prompts ?? []).map((p) =>
        p.prompt.name === target.prompt ? { ...p, behaviour } : p,
      ),
    };
  }
  assertFound(
    fixture.resources?.some((r) => r.resource.uri === target.resource),
    `resource "${target.resource}"`,
    fixture,
  );
  return {
    ...fixture,
    resources: (fixture.resources ?? []).map((r) =>
      r.resource.uri === target.resource ? { ...r, behaviour } : r,
    ),
  };
}

export function withTools(fixture: ServerFixture, tools: ToolFixture[]): ServerFixture {
  return { ...fixture, tools };
}

export function withFault(fixture: ServerFixture, fault: ServerFault): ServerFixture {
  return { ...fixture, faults: [...(fixture.faults ?? []), fault] };
}

/** The definition of a tool by name, for header validation and mirroring. */
export function findTool(fixture: ServerFixture, name: unknown): Tool | undefined {
  return fixture.tools?.find((t) => t.tool.name === name)?.tool;
}

/**
 * A stdio fake runs in another process, so its fixture must survive JSON.stringify:
 * `custom` behaviours (functions) cannot cross. Fails early with a clear message.
 */
export function assertSerializable(fixture: ServerFixture): void {
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "function") found.push(path);
    else if (Array.isArray(value))
      for (const [i, item] of value.entries()) visit(item, `${path}[${i}]`);
    else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  };
  visit(fixture, fixture.name);
  if (found.length > 0) {
    throw new Error(
      `${fixture.name}: a stdio fake runs in a child process, so its fixture must be plain data. ` +
        `Functions found at: ${found.join(", ")}. Use startHttp for "custom" behaviours.`,
    );
  }
}

function assertFound(
  found: boolean | undefined,
  what: string,
  fixture: ServerFixture,
): void {
  if (!found) throw new Error(`${fixture.name} has no ${what}`);
}
