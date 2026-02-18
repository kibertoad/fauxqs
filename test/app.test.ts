import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";

describe("app", () => {
  const app = buildApp({ logger: false });

  afterEach(async () => {
    await app.close();
  });

  it("health check returns ok", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
