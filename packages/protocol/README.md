# @fetchling/protocol

TypeScript types and constants for the
[Model Context Protocol](https://modelcontextprotocol.io) specification,
revision **2026-07-28**, packaged for use inside fetchling.

## Source

`src/schema.ts` is an **unmodified** copy of
[`schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/271ecc9accafdd9b83a3c869fa67c22953b2af80/schema/2026-07-28/schema.ts)
from [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol),
taken at commit `271ecc9accafdd9b83a3c869fa67c22953b2af80`. Do not edit it by
hand. To update it, copy the file from upstream again and record the new
commit here.

The published package includes `src/schema.ts` itself, so you can compare it
with upstream directly; the type declarations in `dist/` are generated from it.

## Integrity

[`upstream.json`](./upstream.json) pins the upstream commit and the SHA-256 of
every vendored file (`src/schema.ts`, `LICENSE`). A test fails if either file
changes by even one byte, so an accidental edit or reformat cannot slip
through. To check whether upstream has moved on (needs network):

```bash
pnpm --filter @fetchling/protocol check-upstream
```

To update: copy the files from upstream, review the diff, then update
`upstream.json` (commit and hashes) and the commit above, in one commit.

## License

The schema is copyright © Model Context Protocol a Series of LF Projects, LLC.
It is distributed under the upstream project's terms: Apache-2.0, with some
earlier contributions still under MIT while the project moves to Apache-2.0.
[`LICENSE`](./LICENSE) is an unmodified copy of the upstream license file and
contains both license texts.

This package's license differs from the rest of fetchling, which is MIT.
