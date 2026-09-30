import type { Tool } from "@fetchling/protocol";
import type { ServerFixture, ToolFixture } from "./fixtures.js";

export interface CatalogOptions {
  /** Same seed, same catalog: a failing search test is reproducible. */
  seed: number;
  servers: number;
  toolsPerServer: number;
  /** "adversarial" appends the edge-case tools from adversarialTools() to every server. */
  vocabulary?: "realistic" | "adversarial";
}

/**
 * A deterministic catalog for search and scale tests (plan Phase 3: "300 tools across
 * 15 upstreams"; §8 soak). Tool names are unique within a server but deliberately
 * repeat across servers, so namespacing (D1) is exercised.
 */
export function generateCatalog(options: CatalogOptions): ServerFixture[] {
  const random = mulberry32(options.seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const fixtures: ServerFixture[] = [];

  for (let s = 0; s < options.servers; s++) {
    const domain = DOMAINS[s % DOMAINS.length] as Domain;
    const name =
      s < DOMAINS.length
        ? domain.server
        : `${domain.server}-${Math.floor(s / DOMAINS.length) + 1}`;
    const tools: ToolFixture[] = [];
    const used = new Set<string>();
    for (
      let t = 0;
      used.size < options.toolsPerServer && t < options.toolsPerServer * 20;
      t++
    ) {
      const verb = pick(VERBS);
      const noun = pick(domain.nouns);
      const toolName = `${verb}_${noun}`;
      if (used.has(toolName)) continue;
      used.add(toolName);
      tools.push({
        tool: realisticTool(toolName, verb, noun, domain, pick),
        behaviour: { kind: "echo" },
      });
    }
    // Top up with numbered names if the vocabulary ran out.
    for (let n = 1; tools.length < options.toolsPerServer; n++) {
      const toolName = `${domain.nouns[0]}_op_${n}`;
      tools.push({
        tool: realisticTool(toolName, "run", domain.nouns[0] as string, domain, pick),
        behaviour: { kind: "echo" },
      });
    }
    if (options.vocabulary === "adversarial") {
      tools.push(...adversarialTools().map((a) => a.fixture));
    }
    fixtures.push({ name, instructions: `Tools for ${domain.description}.`, tools });
  }
  return fixtures;
}

export interface AdversarialTool {
  fixture: ToolFixture;
  /** The checkTool() rule this tool is meant to trip, or null if it is valid despite looking odd. */
  expectedRule: string | null;
  /** Why this case exists. */
  note: string;
}

/**
 * Edge cases every layer of fetchling must survive (plan §2, D1, D18, Phase 3). Each one
 * names the checker rule it trips, so tests can assert detection precisely.
 */
export function adversarialTools(): AdversarialTool[] {
  const tool = (
    name: string,
    inputSchema: Tool["inputSchema"],
    description = "Adversarial fixture",
  ): ToolFixture => ({
    tool: { name, description, inputSchema },
    behaviour: { kind: "echo" },
  });
  const header = (property: Record<string, unknown>) => ({
    type: "object" as const,
    properties: { value: property },
  });

  return [
    {
      fixture: tool(`${"x".repeat(129)}`, { type: "object" }),
      expectedRule: "tool.name.length",
      note: "over 128 characters (tools.md § Tool Names)",
    },
    {
      fixture: tool("admin.tools.list", { type: "object" }),
      expectedRule: null,
      note: "dots are legal; D1 must split on the first dot only",
    },
    {
      fixture: tool("has space", { type: "object" }),
      expectedRule: "tool.name.charset",
      note: "outside [A-Za-z0-9_.-]",
    },
    {
      fixture: tool("dup_name", { type: "object" }),
      expectedRule: null,
      note: "first of a duplicate pair (see next)",
    },
    {
      fixture: tool("dup_name", {
        type: "object",
        properties: { x: { type: "string" } },
      }),
      expectedRule: null,
      note: "duplicate name within one server: checkToolList flags tool.name.unique",
    },
    {
      fixture: tool("no_params", { type: "object", additionalProperties: false }),
      expectedRule: null,
      note: "the recommended no-parameter schema",
    },
    {
      fixture: tool("draft07", {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { a: { type: "number" } },
      }),
      expectedRule: null,
      note: "explicit draft-07 dialect must be preserved",
    },
    {
      fixture: tool("network_ref", {
        type: "object",
        properties: { cfg: { $ref: "https://example.invalid/schema.json" } },
      }),
      expectedRule: null,
      note: "network $ref: must never be fetched (basic.md § $ref Resolution); flagged by Phase 3 resolution, not checkTool",
    },
    {
      fixture: tool("deep_anyof", nestAnyOf(40)),
      expectedRule: null,
      note: "deeply nested composition: validators must bound depth (basic.md § Composition-Keyword Resource Use)",
    },
    {
      fixture: tool("header_ok", {
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: { region: { type: "string", "x-mcp-header": "Region" } },
          },
        },
      }),
      expectedRule: null,
      note: "nested but statically reachable: valid",
    },
    {
      fixture: tool(
        "header_number",
        header({ type: "number", "x-mcp-header": "Amount" }),
      ),
      expectedRule: "tool.xMcpHeader.valid",
      note: "number type is not allowed",
    },
    {
      fixture: tool(
        "header_crlf",
        header({ type: "string", "x-mcp-header": "Bad\r\nName" }),
      ),
      expectedRule: "tool.xMcpHeader.valid",
      note: "control characters in the header name",
    },
    {
      fixture: tool("header_empty", header({ type: "string", "x-mcp-header": "" })),
      expectedRule: "tool.xMcpHeader.valid",
      note: "empty header name",
    },
    {
      fixture: tool(
        "header_space",
        header({ type: "string", "x-mcp-header": "Two Words" }),
      ),
      expectedRule: "tool.xMcpHeader.valid",
      note: "not an HTTP token",
    },
    {
      fixture: tool("header_duplicate", {
        type: "object",
        properties: {
          a: { type: "string", "x-mcp-header": "Region" },
          b: { type: "string", "x-mcp-header": "region" },
        },
      }),
      expectedRule: "tool.xMcpHeader.valid",
      note: "duplicate header names, case-insensitively",
    },
    {
      fixture: tool("header_in_items", {
        type: "object",
        properties: {
          list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } },
        },
      }),
      expectedRule: "tool.xMcpHeader.valid",
      note: "under items: not statically reachable",
    },
    {
      fixture: tool("header_in_oneof", {
        type: "object",
        properties: { v: { oneOf: [{ type: "string", "x-mcp-header": "V" }] } },
      }),
      expectedRule: "tool.xMcpHeader.valid",
      note: "under oneOf: not statically reachable",
    },
    {
      fixture: tool("header_via_ref", {
        type: "object",
        $defs: { r: { type: "string", "x-mcp-header": "R" } },
        properties: { r: { $ref: "#/$defs/r" } },
      }),
      expectedRule: "tool.xMcpHeader.valid",
      note: "reached only through $ref: not statically reachable",
    },
  ];
}

function nestAnyOf(depth: number): Tool["inputSchema"] {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < depth; i++) schema = { anyOf: [schema, { type: "null" }] };
  return { type: "object", properties: { deep: schema } };
}

type Domain = { server: string; description: string; nouns: readonly string[] };

const DOMAINS: readonly Domain[] = [
  {
    server: "filesystem",
    description: "reading and writing local files",
    nouns: ["file", "directory", "path", "symlink", "permissions"],
  },
  {
    server: "github",
    description: "GitHub repositories, issues and pull requests",
    nouns: ["issue", "pull_request", "repository", "branch", "commit", "release"],
  },
  {
    server: "postgres",
    description: "querying a PostgreSQL database",
    nouns: ["table", "query", "schema", "index", "row"],
  },
  {
    server: "slack",
    description: "Slack messaging",
    nouns: ["message", "channel", "thread", "reaction", "user"],
  },
  {
    server: "calendar",
    description: "calendars and meetings",
    nouns: ["event", "calendar", "attendee", "reminder"],
  },
  {
    server: "browser",
    description: "driving a web browser",
    nouns: ["page", "tab", "screenshot", "element", "cookie"],
  },
  {
    server: "jira",
    description: "issue tracking",
    nouns: ["ticket", "sprint", "board", "epic", "comment"],
  },
  {
    server: "docker",
    description: "containers and images",
    nouns: ["container", "image", "volume", "network", "log"],
  },
  {
    server: "s3",
    description: "object storage",
    nouns: ["bucket", "object", "upload", "presigned_url"],
  },
  {
    server: "email",
    description: "sending and reading email",
    nouns: ["email", "draft", "attachment", "folder", "contact"],
  },
  {
    server: "search",
    description: "web search",
    nouns: ["result", "query", "page", "snippet"],
  },
  {
    server: "notes",
    description: "personal notes",
    nouns: ["note", "notebook", "tag", "link"],
  },
  {
    server: "kubernetes",
    description: "Kubernetes clusters",
    nouns: ["pod", "deployment", "service", "namespace", "secret"],
  },
  {
    server: "stripe",
    description: "payments",
    nouns: ["payment", "customer", "invoice", "refund", "subscription"],
  },
  {
    server: "memory",
    description: "long-term agent memory",
    nouns: ["memory", "entity", "relation", "observation"],
  },
];

const VERBS = [
  "get",
  "list",
  "create",
  "update",
  "delete",
  "search",
  "read",
  "write",
  "move",
  "copy",
  "archive",
  "describe",
] as const;

function realisticTool(
  name: string,
  verb: string,
  noun: string,
  domain: Domain,
  pick: <T>(items: readonly T[]) => T,
): Tool {
  const label = noun.replaceAll("_", " ");
  const extra = pick([
    "limit",
    "filter",
    "sort",
    "format",
    "recursive",
    "dry_run",
  ] as const);
  return {
    name,
    description: `${capitalise(verb)} a ${label} (${domain.description}).`,
    inputSchema: {
      type: "object",
      properties: {
        [`${noun}_id`]: { type: "string", description: `Identifier of the ${label}` },
        [extra]: {
          type: extra === "recursive" || extra === "dry_run" ? "boolean" : "string",
        },
      },
      required: [`${noun}_id`],
    },
    ...(verb === "delete"
      ? { annotations: { destructiveHint: true, readOnlyHint: false } }
      : {}),
    ...(verb === "get" ||
    verb === "list" ||
    verb === "read" ||
    verb === "search" ||
    verb === "describe"
      ? { annotations: { readOnlyHint: true } }
      : {}),
  };
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Small, fast, seedable PRNG. Not for anything security-related. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
