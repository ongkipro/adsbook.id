/**
 * The key a tenant's admin sessions are signed with: 256 random bits kept in
 * that tenant's own `install_secrets` (ADR-026), generated on first use and at
 * provisioning (T-26). Never from the environment (T-21, TEN-4): the Worker's
 * `AUTH_SECRET` would be one key for every tenant, so a session of one tenant
 * would verify on another.
 *
 * `INSERT OR IGNORE` then `SELECT` makes two first requests agree on one key.
 * Cached per tenant id (T-18): the value never changes once written, and the
 * middleware would otherwise read it on every admin request. Keyed by the
 * tenant, not by the database object — a tenant store handle is a new object
 * on every request, and two tenants must never share an entry. A caller that
 * does not pass a tenant id gets no caching.
 */
const cache = new Map<string, string>();

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function resolveAuthSecret(
  database: D1Database | undefined,
  tenantId?: string,
): Promise<string> {
  if (!database) return "";

  const cached = tenantId ? cache.get(tenantId) : undefined;
  if (cached) return cached;

  try {
    const read = () =>
      database
        .prepare("SELECT value FROM install_secrets WHERE name = 'auth_secret'")
        .first<{ value: string }>();
    let row = await read();
    if (!row?.value) {
      await database
        .prepare(
          "INSERT OR IGNORE INTO install_secrets (name, value, created_at) VALUES ('auth_secret', ?, ?)",
        )
        .bind(randomSecret(), new Date().toISOString())
        .run();
      row = await read();
    }
    if (row?.value && row.value.length >= 32) {
      if (tenantId) cache.set(tenantId, row.value);
      return row.value;
    }
  } catch (error) {
    // Fail closed: an empty secret makes login answer 503 and every session
    // read return null. Never fall back to a guessable key.
    console.error("auth-secret-unavailable", error);
  }
  return "";
}
