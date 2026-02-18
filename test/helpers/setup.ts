import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

export interface TestServer {
  app: FastifyInstance;
  port: number;
  baseUrl: string;
}

export async function createTestServer(): Promise<TestServer> {
  const app = buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const url = new URL(address);
  return {
    app,
    port: parseInt(url.port),
    baseUrl: address,
  };
}
