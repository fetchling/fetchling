// Public surface of @fetchling/testkit. Everything not exported here is internal and may change.
export { validateBehaviour } from "./behaviour.js";
export {
  type AdversarialTool,
  adversarialTools,
  type CatalogOptions,
  generateCatalog,
} from "./catalog.js";
export {
  type CheckResponseOptions,
  checkFrame,
  checkHttpExchange,
  checkRequest,
  checkResponse,
  checkStream,
  checkTool,
  checkToolList,
  type HttpExchangeRecord,
  type Severity,
  type StreamEntry,
  type Violation,
} from "./checker.js";
export {
  type Cluster,
  type McpConfig,
  type StartClusterOptions,
  startCluster,
} from "./cluster.js";
export type { FakeUpstream, McpServerEntry, Target } from "./fake.js";
export * from "./fixtures.js";
export {
  createHandler,
  DEFAULT_CACHE,
  deriveCapabilities,
  type Handler,
  type HandlerOptions,
} from "./handler.js";
export {
  type HttpFakeUpstream,
  type StartHttpOptions,
  startHttp,
} from "./http-transport.js";
export {
  checkRequestHeaders,
  decodeHeaderValue,
  encodeHeaderValue,
  type ParamHeaderSpec,
  paramHeaderValue,
  requestHeaders,
  scanParamHeaders,
} from "./mcp-headers.js";
export { META, meta, request, TESTKIT_CLIENT } from "./meta.js";

export {
  type ClientTarget,
  type RawClient,
  type RawExchange,
  type RawRequestOptions,
  type RawSubscription,
  rawClient,
  rawClients,
} from "./raw-client.js";
export {
  DIFF_IGNORE_DEFAULTS,
  diffTraffic,
  type Frame,
  type FrameFilter,
  type Traffic,
  type TrafficDiff,
  type TrafficDifference,
  type TrafficEvent,
  type TrafficEventKind,
} from "./recorder.js";
export { textResult } from "./results.js";
export {
  type StdioFakeUpstream,
  type StdioInstance,
  startStdio,
} from "./stdio-transport.js";
export type { Step } from "./steps.js";
