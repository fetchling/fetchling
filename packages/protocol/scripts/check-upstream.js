// Compares the vendored files with upstream `main` (needs network; never run in CI).
// Usage: pnpm --filter @fetchling/protocol check-upstream
// Exit code 0 = up to date, 1 = upstream has changed (re-vendor and review the diff), 2 = error.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const upstream = JSON.parse(
  readFileSync(new URL("../upstream.json", import.meta.url), "utf8"),
);
const repo = upstream.repository.replace("https://github.com/", "");
const out = (line) => process.stdout.write(`${line}\n`);

let changed = false;
try {
  for (const [path, { upstreamPath, sha256 }] of Object.entries(upstream.files)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${repo}/main/${upstreamPath}`,
    );
    if (!response.ok) throw new Error(`${upstreamPath}: HTTP ${response.status}`);
    const latest = createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex");
    const same = latest === sha256;
    changed ||= !same;
    out(`${same ? "unchanged" : "CHANGED  "}  ${path}  ←  ${upstreamPath}`);
  }
  out(
    changed
      ? `\nUpstream main differs from the pinned commit ${upstream.commit.slice(0, 10)}. To update: copy the files from upstream, review the diff, then update upstream.json (commit + hashes) and README.md together.`
      : `\nUp to date with upstream main (pinned commit ${upstream.commit.slice(0, 10)}).`,
  );
  process.exit(changed ? 1 : 0);
} catch (error) {
  process.stderr.write(`check-upstream failed: ${error.message}\n`);
  process.exit(2);
}
