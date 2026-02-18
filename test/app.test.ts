import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";

describe("app", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp({ logger: false });
  });

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

  it("GetCallerIdentity returns mock STS response", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "Action=GetCallerIdentity&Version=2011-06-15",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/xml");
    expect(response.body).toContain("<GetCallerIdentityResponse");
    expect(response.body).toContain("<Account>000000000000</Account>");
    expect(response.body).toContain("<Arn>arn:aws:iam::000000000000:root</Arn>");
    expect(response.body).toContain("<UserId>000000000000</UserId>");
  });
});
