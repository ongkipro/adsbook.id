import type { MigrationSource } from "../lib/schema-version.ts";

/**
 * The control-plane chain (`src/platform/migrations/`), embedded by Vite at
 * build time. Loaded only inside the Worker; Node tests read the files directly.
 */
const migrationModules = import.meta.glob("./migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
});

export const PLATFORM_MIGRATIONS: readonly MigrationSource[] = Object.entries(migrationModules)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql: String(sql) }))
  .sort((left, right) => left.name.localeCompare(right.name));
