# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): one
markdown file per pending change, each naming the affected packages and their
bump level.

- `pnpm changeset` — write one, after making a change worth releasing.
- `pnpm version-packages` — apply every pending changeset: bump versions, bump
  dependents, rewrite internal dependency ranges, write CHANGELOGs. Review the
  diff, then commit it.
- `pnpm release` — build and publish.

Versioning is independent per package, and `fetchling` (the CLI) is the
project's headline version. See D11 in the project plan.
