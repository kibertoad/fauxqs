import {
  startFauxqs,
  type FauxqsServer,
  type RelaxedRules,
  type StrictRules,
} from "../../src/app.js";

export type { FauxqsServer };

export function startFauxqsTestServer(opts?: {
  relaxedRules?: RelaxedRules;
  strictRules?: StrictRules;
}): Promise<FauxqsServer> {
  return startFauxqs({
    port: 0,
    logger: false,
    relaxedRules: opts?.relaxedRules,
    strictRules: opts?.strictRules,
  });
}

export function startFauxqsTestServerWithHost(host: string): Promise<FauxqsServer> {
  return startFauxqs({ port: 0, logger: false, host });
}
