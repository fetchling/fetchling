// Guards plan D15: the vendored spec files stay byte-identical to the pinned upstream commit.
// Lives outside src/ on purpose: src/ compiles with "types": [] (no Node APIs), this test needs node:fs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const upstream = JSON.parse(read("upstream.json").toString("utf8")) as {
  commit: string;
  files: Record<string, { upstreamPath: string; sha256: string }>;
};

describe("vendored upstream files", () => {
  it.each(Object.entries(upstream.files))(
    "%s is byte-identical to the pinned upstream file",
    (path, { sha256 }) => {
      const actual = createHash("sha256").update(read(path)).digest("hex");
      // A mismatch means the file was edited (or reformatted). Never edit it by hand:
      // re-copy it from upstream and update upstream.json and README.md in one commit.
      expect(actual).toBe(sha256);
    },
  );

  it("README.md names the same upstream commit as upstream.json", () => {
    expect(read("README.md").toString("utf8")).toContain(upstream.commit);
  });
});
