import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
      thresholds: {
        statements: 70,
        branches: 50,
        functions: 85,
        lines: 70,
      },
    },
  },
});
