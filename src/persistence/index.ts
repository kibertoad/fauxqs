export type { PersistenceProvider } from "./persistenceProvider.ts";
export { SqlitePersistence } from "./sqlitePersistence.ts";
export { PgPersistence } from "./pgPersistence.ts";

export async function createPersistence(
  options: { type: "sqlite"; dataDir: string } | { type: "postgresql"; connectionString: string },
): Promise<import("./persistenceProvider.ts").PersistenceProvider> {
  if (options.type === "postgresql") {
    const { PgPersistence } = await import("./pgPersistence.ts");
    return PgPersistence.create(options.connectionString);
  }
  const { SqlitePersistence } = await import("./sqlitePersistence.ts");
  return new SqlitePersistence(options.dataDir);
}
