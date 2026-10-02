# @fetchling/protocol

## 0.1.0

### Minor Changes

- First public release. TypeScript types and constants for the Model Context Protocol, revision
  2026-07-28: an unmodified copy of `schema/2026-07-28/schema.ts` from
  modelcontextprotocol/modelcontextprotocol at commit `271ecc9a`, re-exported for fetchling.
  
  Licensed `(Apache-2.0 AND MIT)` like its upstream (the MCP project is moving from MIT to
  Apache-2.0); the upstream `LICENSE` is included verbatim. A hash check keeps the vendored files
  byte-identical to that commit, and the package ships the original `src/schema.ts` alongside the
  generated types. Requires Node 22 or newer.
