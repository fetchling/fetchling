# @fetchling/core

## 0.0.2

### Patch Changes

- Build both packages from TypeScript sources with tsdown.
  
  The CLI binary moves from `bin.js` at the package root to `dist/bin.js`, and
  `@fetchling/core` now ships `dist/index.js` with generated type declarations
  and declaration maps. Both packages gain a `homepage` pointing at
  https://fetchling.sh, and the CLI's `repository.directory` is corrected to
  `packages/cli` after the directory rename.
  
  No behavioural change: the CLI still prints the not-yet-released notice.
