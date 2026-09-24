import { startFauxqs, type FauxqsServer, type RelaxedRules } from "../../src/app.js";

export type { FauxqsServer };

export function startFauxqsTestServer(opts?: {
  relaxedRules?: RelaxedRules;
}): Promise<FauxqsServer> {
  return startFauxqs({
    port: 0,
    logger: false,
    relaxedRules: opts?.relaxedRules,
  });
}

export function startFauxqsTestServerWithHost(host: string): Promise<FauxqsServer> {
  return startFauxqs({ port: 0, logger: false, host });
}
