import { startFauxqs } from "./app.ts";

const dataDir = process.env.FAUXQS_DATA_DIR;
const persistenceEnv = process.env.FAUXQS_PERSISTENCE;
const enablePersistence = dataDir && persistenceEnv !== "false";

startFauxqs({
  logger: true,
  ...(enablePersistence ? { dataDir } : {}),
});
