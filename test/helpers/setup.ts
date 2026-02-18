import { startFauxqs, type FauxqsServer } from "../../src/app.js";

export type { FauxqsServer };

export function startFauxqsTestServer(): Promise<FauxqsServer> {
  return startFauxqs({ port: 0, logger: false });
}
