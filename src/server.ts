import { readFileSync } from "node:fs";
import { startFauxqs } from "./app.ts";
import type { TenantConfig } from "./tenant/tenantTypes.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const enablePersistence = dataDir && persistenceEnv === "true";
const s3StorageDir = process.env.FAUXQS_S3_STORAGE_DIR;

// Tenant management env vars
const tenantTtlEnv = process.env.FAUXQS_TENANT_TTL;
let tenant: TenantConfig | undefined;
if (tenantTtlEnv) {
  const ttlMs = parseInt(tenantTtlEnv, 10) * 1000;
  const sweepIntervalEnv = process.env.FAUXQS_TENANT_SWEEP_INTERVAL;
  const sweepBudgetEnv = process.env.FAUXQS_TENANT_SWEEP_BUDGET;
  const permanentPrefixesEnv = process.env.FAUXQS_TENANT_PERMANENT_PREFIXES;
  const templateEnv = process.env.FAUXQS_TENANT_TEMPLATE;
  const adminQueueEnv = process.env.FAUXQS_TENANT_ADMIN_QUEUE;

  tenant = {
    ttlMs,
    ...(sweepIntervalEnv ? { sweepIntervalMs: parseInt(sweepIntervalEnv, 10) * 1000 } : {}),
    ...(sweepBudgetEnv ? { sweepBudget: parseInt(sweepBudgetEnv, 10) } : {}),
    ...(permanentPrefixesEnv ? { permanentPrefixes: permanentPrefixesEnv.split(",") } : {}),
    ...(templateEnv && templateEnv !== "init"
      ? { template: JSON.parse(readFileSync(templateEnv, "utf-8")) }
      : {}),
    ...(adminQueueEnv
      ? { adminQueue: adminQueueEnv === "true" ? true : adminQueueEnv }
      : {}),
  };
}

startFauxqs({
  logger: true,
  ...(enablePersistence ? { dataDir } : {}),
  ...(s3StorageDir ? { s3StorageDir } : {}),
  ...(tenant ? { tenant } : {}),
});
