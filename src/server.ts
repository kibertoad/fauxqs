import { startFauxqs } from "./app.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const persistenceBackend = (process.env.FAUXQS_PERSISTENCE_BACKEND ?? "sqlite") as
  | "sqlite"
  | "postgresql";
const postgresqlUrl = process.env.FAUXQS_POSTGRESQL_URL;
const s3StorageDir = process.env.FAUXQS_S3_STORAGE_DIR;

const enablePersistence =
  persistenceBackend === "postgresql"
    ? persistenceEnv === "true" && !!postgresqlUrl
    : persistenceEnv === "true" && !!dataDir;

startFauxqs({
  logger: true,
  ...(enablePersistence ? { persistenceBackend } : {}),
  ...(enablePersistence && persistenceBackend === "sqlite" ? { dataDir } : {}),
  ...(enablePersistence && persistenceBackend === "postgresql" ? { postgresqlUrl } : {}),
  ...(s3StorageDir ? { s3StorageDir } : {}),
});
