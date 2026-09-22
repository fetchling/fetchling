import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    environment: "node",
    passWithNoTests: true,
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
