import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["examples/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/s3/s3Types.ts", "src/sns/snsTypes.ts"],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 95,
        lines: 90,
      },
    },
  },
});
