import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 90,
        lines: 85,
      },
    },
  },
});
