import type {
  CallToolResult,
  ClientCapabilities,
  GetPromptResult,
  InputRequests,
  JSONRPCRequest,
  Prompt,
  PromptReference,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ResourceTemplateReference,
  ServerCapabilities,
  Tool,
} from "@fetchling/protocol";

/** Freshness hint attached to every cachable result. */
export interface CachePolicy {
  ttlMs: number;
  cacheScope: "public" | "private";
}

/**
 * Everything a fake upstream is. Plain data on purpose: a stdio fake runs in a child
 * process, so its fixture must survive JSON.stringify. The only exception is the
 * "custom" behaviour, which works in-process only.
 */
export interface ServerFixture {
  name: string;
  version?: string;
  instructions?: string;
  /** Default ["2026-07-28"]. A request for any other version gets -32022. */
  supportedVersions?: string[];
  /** Default: derived from what the fixture contains. */
  capabilities?: ServerCapabilities;
  tools?: ToolFixture[];
  prompts?: PromptFixture[];
  resources?: ResourceFixture[];
  /** Listed only; reading a resource through a template is not implemented yet. */
  resourceTemplates?: ResourceTemplate[];
  completions?: CompletionFixture[];
  cache?: CachePolicy;
  faults?: ServerFault[];
  /** "strict" (the default) rejects requests that break the spec, as a careful server would. */
  inbound?: "strict" | "lenient";
  /**
   * Items per page for tools/list, prompts/list, resources/list and
   * resources/templates/list. Default: everything on one page, no `nextCursor`.
   */
  pageSize?: number;
  /**
   * HTTP only. How a request's answer is framed: "json" (one JSON body), "sse" (an
   * event stream) or "auto" (the default: JSON when the script is a single response,
   * a stream when it has notifications, waits or never ends). Errors that carry an
   * HTTP status (400, 404) are always sent as JSON with that status.
   */
  responseMode?: "auto" | "json" | "sse";
  /** HTTP only. `Origin` values accepted besides localhost ones; others get 403. */
  allowedOrigins?: string[];
  /** HTTP only. Interval of `:` keep-alive comments on open streams. Default 15000; 0 disables. */
  keepAliveMs?: number;
}

export interface ToolFixture {
  tool: Tool;
  behaviour: Behaviour;
}

export interface PromptFixture {
  prompt: Prompt;
  behaviour: Behaviour;
}

export interface ResourceFixture {
  resource: Resource;
  behaviour: Behaviour;
}

export interface CompletionFixture {
  ref: PromptReference | ResourceTemplateReference;
  argument: string;
  values: string[];
}

/** Ask the client for input before continuing. At least one of the two fields is required. */
export interface InputRequiredBehaviour {
  kind: "inputRequired";
  inputRequests?: InputRequests;
  /** The fake's own opaque state. The client must echo it back unchanged on retry. */
  requestState?: string;
  next: Behaviour;
}

/** "Come back later": requestState only, no questions. Legal per the schema. */
export interface LoadShedBehaviour {
  kind: "loadShed";
  requestState: string;
  next: Behaviour;
}

export interface MatchCase {
  /** Compares a dotted path inside the request params, e.g. "arguments.path". */
  when: { path: string; equals: unknown };
  behaviour: Behaviour;
}

export type Behaviour =
  | { kind: "respond"; result: CallToolResult | GetPromptResult | ReadResourceResult }
  | { kind: "echo" }
  | { kind: "toolError"; message: string }
  | { kind: "protocolError"; code: number; message: string; data?: unknown }
  | InputRequiredBehaviour
  | LoadShedBehaviour
  | { kind: "delay"; ms: number; next: Behaviour }
  | { kind: "progress"; steps: number; intervalMs: number; next: Behaviour }
  | { kind: "hang" }
  | { kind: "sequence"; steps: Behaviour[]; after?: Behaviour }
  | { kind: "match"; cases: MatchCase[]; otherwise: Behaviour }
  | { kind: "malformed"; mode: MalformedMode }
  | { kind: "crash"; exitCode?: number }
  | { kind: "custom"; fn: (request: JSONRPCRequest) => Behaviour };

export type MalformedMode =
  | "invalidJson"
  | "missingResultType"
  | "unknownResultType"
  | "nullId"
  | "wrongId"
  | "duplicateResponse"
  | "notificationFlood"
  | "legacyErrorCode";

export type ServerFault =
  // played by the handler
  | { kind: "dieAfter"; requests: number }
  | { kind: "requireCapability"; capabilities: ClientCapabilities }
  | { kind: "noServerInfo" }
  | { kind: "omitCacheFields" }
  | { kind: "skipSubscriptionAck" }
  // played by transports; the handler ignores these
  | { kind: "slowStart"; ms: number }
  | { kind: "exitOnIdle"; ms: number }
  | { kind: "headerMismatch" };
