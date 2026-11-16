/**
 * Tests: give a database fake the binding every production tenant handle has
 * (ADR-040), with a fixed test key, so a fixture's provider keys read as they
 * would on a real store. Fail-closed behaviour is tested without it.
 */
import { bindCredentials } from "../../lib/credential-crypto.ts";

export const TEST_CREDENTIAL_ENV = { PLATFORM_CREDENTIAL_KEY: Buffer.alloc(32, 1).toString("base64") };

export function withTestCredentials<T extends object>(database: T, tenantId = "test-tenant"): T {
  return bindCredentials(database, tenantId, TEST_CREDENTIAL_ENV);
}

/** Bind whatever a fixture factory returns: the handle itself, or the handles it carries. */
export function bindTestCredentialsIn<T>(result: T): T {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then((value) => bindTestCredentialsIn(value)) as unknown as T;
  }
  if (!result || typeof result !== "object") return result;
  if (typeof (result as { prepare?: unknown }).prepare === "function") return withTestCredentials(result as object) as T;
  // The handle itself, or one level down (e.g. `{ sqlite, locals: { tenantDb } }`).
  for (const value of Object.values(result as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    if (typeof (value as { prepare?: unknown }).prepare === "function") withTestCredentials(value as object);
    else for (const inner of Object.values(value as Record<string, unknown>)) {
      if (inner && typeof inner === "object" && typeof (inner as { prepare?: unknown }).prepare === "function") withTestCredentials(inner as object);
    }
  }
  return result;
}
