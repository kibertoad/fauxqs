import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // setupFiles run in the test worker process (not the main vitest process),
    // so interceptLocalhostDns() patches DNS where the SDK clients actually live.
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
