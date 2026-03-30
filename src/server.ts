import { startFauxqs } from "./app.ts";
import { loadInitConfig } from "./initConfig.ts";
import type { FauxqsInitConfig } from "./initConfig.ts";
import type { TenantConfig } from "./tenant/tenantTypes.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const enablePersistence = dataDir && persistenceEnv === "true";
const s3StorageDir = process.env.FAUXQS_S3_STORAGE_DIR;

// Tenant management env vars
const tenantTtlEnv = process.env.FAUXQS_TENANT_TTL;
let tenant: TenantConfig | undefined;
if (tenantTtlEnv) {
  const parsedTtl = parseInt(tenantTtlEnv, 10);
  if (Number.isNaN(parsedTtl) || parsedTtl <= 0) {
    throw new Error(`FAUXQS_TENANT_TTL must be a positive integer (got "${tenantTtlEnv}")`);
  }
  const ttlMs = parsedTtl * 1000;

  const sweepIntervalEnv = process.env.FAUXQS_TENANT_SWEEP_INTERVAL;
  const sweepBudgetEnv = process.env.FAUXQS_TENANT_SWEEP_BUDGET;
  const permanentPrefixesEnv = process.env.FAUXQS_TENANT_PERMANENT_PREFIXES;
  const templateEnv = process.env.FAUXQS_TENANT_TEMPLATE;
  const adminQueueEnv = process.env.FAUXQS_TENANT_ADMIN_QUEUE;

  let sweepIntervalMs: number | undefined;
  if (sweepIntervalEnv) {
    const parsed = parseInt(sweepIntervalEnv, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `FAUXQS_TENANT_SWEEP_INTERVAL must be a positive integer (got "${sweepIntervalEnv}")`,
      );
    }
    sweepIntervalMs = parsed * 1000;
  }

  let sweepBudget: number | undefined;
  if (sweepBudgetEnv) {
    const parsed = parseInt(sweepBudgetEnv, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `FAUXQS_TENANT_SWEEP_BUDGET must be a positive integer (got "${sweepBudgetEnv}")`,
      );
    }
    sweepBudget = parsed;
  }

  // Resolve template: "init" means reuse FAUXQS_INIT, a path loads a separate file.
  // When "init" is specified, the template comes from the init config automatically
  // (TenantManager falls back to init config when no explicit template is set).
  let templateConfig: FauxqsInitConfig | undefined;
  if (templateEnv && templateEnv !== "init") {
    try {
      templateConfig = loadInitConfig(templateEnv);
    } catch (err) {
      throw new Error(
        `FAUXQS_TENANT_TEMPLATE file "${templateEnv}" is invalid: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  tenant = {
    ttlMs,
    ...(sweepIntervalMs !== undefined ? { sweepIntervalMs } : {}),
    ...(sweepBudget !== undefined ? { sweepBudget } : {}),
    ...(permanentPrefixesEnv ? { permanentPrefixes: permanentPrefixesEnv.split(",") } : {}),
    ...(templateConfig ? { template: templateConfig } : {}),
    ...(adminQueueEnv ? { adminQueue: adminQueueEnv === "true" ? true : adminQueueEnv } : {}),
  };
}

startFauxqs({
  logger: true,
  ...(enablePersistence ? { dataDir } : {}),
  ...(s3StorageDir ? { s3StorageDir } : {}),
  ...(tenant ? { tenant } : {}),
});
