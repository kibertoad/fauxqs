import { startFauxqs } from "./app.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const persistenceBackend = process.env.FAUXQS_PERSISTENCE_BACKEND ?? "sqlite";
const postgresqlUrl = process.env.FAUXQS_POSTGRESQL_URL;
const s3StorageDir = process.env.FAUXQS_S3_STORAGE_DIR;

if (persistenceBackend !== "sqlite" && persistenceBackend !== "postgresql") {
  throw new Error(
    `Invalid FAUXQS_PERSISTENCE_BACKEND: "${persistenceBackend}". Must be "sqlite" or "postgresql".`,
  );
}

if (persistenceEnv === "true") {
  if (persistenceBackend === "postgresql" && !postgresqlUrl) {
    throw new Error("FAUXQS_POSTGRESQL_URL is required when FAUXQS_PERSISTENCE_BACKEND=postgresql");
  }
  if (persistenceBackend === "sqlite" && !dataDir) {
    throw new Error("FAUXQS_DATA_DIR is required when FAUXQS_PERSISTENCE_BACKEND=sqlite");
  }
}

const enablePersistence =
  persistenceEnv === "true" && (persistenceBackend === "postgresql" ? !!postgresqlUrl : !!dataDir);

startFauxqs({
  logger: true,
  ...(enablePersistence ? { persistenceBackend } : {}),
  ...(enablePersistence && persistenceBackend === "sqlite" ? { dataDir } : {}),
  ...(enablePersistence && persistenceBackend === "postgresql" ? { postgresqlUrl } : {}),
  ...(s3StorageDir ? { s3StorageDir } : {}),
});
