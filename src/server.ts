import { startFauxqs } from "./app.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const enablePersistence = dataDir && persistenceEnv === "true";
const s3StorageDir = process.env.FAUXQS_S3_STORAGE_DIR;

startFauxqs({
  logger: true,
  ...(enablePersistence ? { dataDir } : {}),
  ...(s3StorageDir ? { s3StorageDir } : {}),
});
