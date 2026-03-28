import type { FauxqsInitConfig } from "../initConfig.ts";

export interface TenantConfig {
  /** TTL in milliseconds. Resources unused for longer than this are candidates for deletion. */
  ttlMs: number;
  /** How often to run the cleanup sweep, in milliseconds. Defaults to ttlMs / 10 (min 50ms). */
  sweepIntervalMs?: number;
  /** Max number of resources inspected per sweep tick. Defaults to 50. */
  sweepBudget?: number;
  /** Prefixes exempt from auto-cleanup. Include "" to make unprefixed / non-tenant-managed resources permanent. */
  permanentPrefixes?: string[];
  /** Explicit template config for prefixed instantiation. If omitted, uses the init config. */
  template?: FauxqsInitConfig;
  /** Enable the admin SQS queue for template instantiation via messages. true = default name "_fauxqs-admin", string = custom name. */
  adminQueue?: boolean | string;
}

/** Message format for the admin SQS queue. */
export interface TemplateRequest {
  action: "instantiate";
  prefix: string;
}
