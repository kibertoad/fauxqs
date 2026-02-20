import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 95,
        lines: 85,
      },
    },
  },
});
