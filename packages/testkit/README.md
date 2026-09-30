# @fetchling/testkit

Fake MCP servers, a raw client, a traffic recorder and a spec-rule checker — the test
foundation for [fetchling](https://github.com/fetchling/fetchling). Targets MCP revision
`2026-07-28`. Private for now: its API will change while fetchling's phases are built.

Fetchling is a proxy, so its correctness is a relationship between two conversations — what a
host sent and what an upstream received. Testing that needs upstreams you can command. That is
what this package is.

## The pieces

| Piece | What it is | Main exports |
|---|---|---|
| **Fixtures** | Plain data describing a fake server: its tools, prompts, resources and how each behaves | `ServerFixture`, `Behaviour`, `ServerFault` |
| **Handler** | The pure core: one request in, a *step script* out (send, wait, crash, hang…). No I/O | `createHandler` |
| **Transports** | Play step scripts over Streamable HTTP (in-process) or stdio (child process) | `startHttp`, `startStdio`, `startCluster` |
| **Raw client** | Sends exactly what you tell it — valid by default, broken on request | `rawClient`, `rawClients` |
| **Recorder** | Every frame in and out, in total order, with HTTP headers and stdio instance ids | `fake.traffic`, `diffTraffic` |
| **Checker** | The spec as named rules (`id.uniqueInFlight`, `cacheable.ttlMs`, …) | `checkResponse`, `checkStream`, `checkTool`, `checkHttpExchange`, … |
| **Header rules** | `Mcp-*` headers, `x-mcp-header`, Base64 sentinel encoding | `requestHeaders`, `checkRequestHeaders`, `scanParamHeaders` |
| **Catalogs** | Deterministic tool catalogs for scale/search tests, plus adversarial edge cases | `generateCatalog`, `adversarialTools` |

The rule table mapping every spec requirement to a checker rule and a test lives in
`res/docs/spec-notes.md` (local project notes).

## Quick examples

### A fake over HTTP, a request, and the checker

```ts
import { checkResponse, rawClient, startHttp } from "@fetchling/testkit";

const fake = await startHttp({
  name: "fs",
  tools: [{ tool: { name: "read_file", inputSchema: { type: "object" } }, behaviour: { kind: "echo" } }],
});
const client = rawClient(fake);
const exchange = await client.request("tools/list", {}, { id: 1 });
checkResponse({ id: 1, method: "tools/list" }, exchange.response); // → [] when spec-clean
await fake.stop();
```

### Point fetchling at several fakes through its real config path

```ts
const cluster = await startCluster([fsFixture, githubFixture], { transport: "mixed" });
const config = cluster.mcpConfig(); // { mcpServers: { fs: { command, args }, github: { type: "http", url } } }
// …start fetchling with `config`, drive it, then inspect each upstream:
expect(cluster.get("fs").traffic.count({ method: "tools/call" })).toBe(0);
```

### Behaviours

```ts
{ kind: "echo" }                                             // return the arguments
{ kind: "toolError", message: "ENOENT" }                     // isError: true result
{ kind: "protocolError", code: -32602, message: "…" }        // JSON-RPC error
{ kind: "delay", ms: 800, next: { kind: "echo" } }
{ kind: "progress", steps: 3, intervalMs: 10, next: … }      // needs a progressToken
{ kind: "inputRequired", inputRequests: {…}, requestState: "own-state", next: … }  // MRTR
{ kind: "loadShed", requestState: "later", next: … }         // requestState only
{ kind: "sequence", steps: [ok, fail], after: ok }           // "fails on the 2nd call"
{ kind: "match", cases: [{ when: { path: "arguments.path", equals: "/x" }, behaviour }], otherwise }
{ kind: "malformed", mode: "missingResultType" }             // and 7 more modes
{ kind: "hang" } · { kind: "crash", exitCode: 1 } · { kind: "custom", fn } (HTTP only)
```

Server-level faults: `dieAfter`, `requireCapability`, `noServerInfo`, `omitCacheFields`,
`skipSubscriptionAck` (handler); `slowStart`, `exitOnIdle`, `headerMismatch` are declared for
transports but **not implemented yet**.

### Steering a fake mid-test

```ts
await fake.setBehaviour({ tool: "read_file" }, { kind: "crash" });
await fake.setTools(newTools);               // notifies toolsListChanged subscribers
await fake.emit({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
await fake.kill();                           // HTTP: server dies; stdio: SIGKILL every process
await httpFake.restart();                    // HTTP: a fresh "process" on the same port
```

On stdio these cross a process boundary; they resolve once every running process has applied them.

### Comparing conversations (Phase 1's regression test)

```ts
const diff = diffTraffic(direct.traffic.frames(), proxied.traffic.frames());
// Ignores ids, client identity, trace context and server identity by default
// (DIFF_IGNORE_DEFAULTS, as JSON Pointers). Differences come back as JSON Pointers.
```

## How stdio fakes work

On stdio the process under test (fetchling) spawns the fake and owns its pipes, so a test cannot
watch them. `startStdio` therefore starts nothing itself: it returns `command` + `args`. Every
process spawned from them connects back to the test over a local TCP control socket, reports each
frame and event, and accepts commands (new fixture, emit, stop). `fake.traffic` shows all
instances; frames carry `instance` (1, 2, … in spawn order).

The child entry point is `dist/stdio-main.js`, so **stdio fakes need a build** (`pnpm build`,
which the root `test` script runs first). Fixtures for stdio must be plain JSON — `custom`
behaviours are rejected with a clear error.

## Design rules

- **The fake is strict about what it receives** (`inbound: "strict"`, the default): missing
  `_meta` → `-32602`, header/body mismatch → `-32020`, undeclared capability → `-32021`. So every
  test through fetchling also checks the requests fetchling builds.
- **Not built on the MCP SDK**, on purpose: a correct SDK refuses to emit invalid messages, and
  testkit must be able to.
- **Handler output is data** (step scripts), which keeps the core testable without sockets.
- Every control method is `async` and every fake is `AsyncDisposable` (`await using fake = …`).

## Tests

145 tests across fixtures, handler, checker, header rules, SSE, recorder, catalogs, and HTTP /
stdio / cluster integration: `pnpm test` from the repository root.
