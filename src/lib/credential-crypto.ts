/**
 * Stored provider credentials, envelope-encrypted with a platform key (ADR-040, T-48).
 *
 * The root is the platform Worker secret `PLATFORM_CREDENTIAL_KEY` (32 random
 * bytes, base64, optionally prefixed `v<N>:` to name its version). Each tenant's
 * data key is HKDF-SHA-256 of it (salt = tenant id), and every value is
 * AES-256-GCM with a fresh 96-bit IV and `<tenant id>\n<column>` as additional
 * data, stored as `enc:v1:<key version>:<iv>:<ciphertext>` (base64url). A value
 * copied into another tenant's store or another column does not decrypt.
 *
 * The cipher is bound to a tenant database handle where the platform opens it
 * (`openTenantDb`, the tenant alarm), so every reader that holds the handle can
 * decrypt and nothing else needs the tenant id or the env.
 *
 * Fail closed, always: a handle without a binding or without a usable key opens
 * nothing (every credential reads as not set) and seals nothing (a write throws,
 * so plaintext is never stored). A value that fails to decrypt reads as not set.
 * A legacy plaintext value is accepted on read only while a key is present, and
 * `encryptStoredCredentials` (the tenant alarm's sweep) replaces it.
 */

const PREFIX = "enc:v1:";
const INFO = new TextEncoder().encode("adsbook.id/provider-credentials/v1");

/** The `stores` columns that hold a provider secret. */
export const STORE_CREDENTIAL_COLUMNS = [
  "mengantar_api_key",
  "mengantar_webhook_secret",
  "autolaris_api_key",
  "meta_capi_token",
  "google_ads_developer_token",
  "google_ads_client_secret",
  "google_ads_refresh_token",
  "tiktok_access_token",
] as const;
export type StoreCredentialColumn = (typeof STORE_CREDENTIAL_COLUMNS)[number];

type Bytes = Uint8Array<ArrayBuffer>;
type RootKey = { version: string; raw: Bytes };
type KeyRing = { current: RootKey; previous: RootKey | null };
type Binding = { tenantId: string; ring: KeyRing | null };

export class CredentialKeyUnavailableError extends Error {
  constructor() {
    super("CREDENTIAL_KEY_UNAVAILABLE: the platform credential key is not set, so a credential cannot be stored");
    this.name = "CredentialKeyUnavailableError";
  }
}

/** Indonesian copy for an admin save refused because the platform key is missing. */
export const CREDENTIAL_KEY_UNAVAILABLE_MESSAGE =
  "Penyimpanan kredensial sedang tidak tersedia. Coba lagi nanti atau hubungi tim adsbook.id.";

const bindings = new WeakMap<object, Binding>();

function decodeBase64(value: string): Bytes | null {
  try {
    const normal = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `v<N>:<base64>` or `<base64>` (version 1); null when it is not 32 bytes. */
export function parseCredentialKey(value: unknown): RootKey | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:v([0-9]{1,6}):)?([A-Za-z0-9+/_=-]+)$/);
  if (!match) return null;
  const raw = decodeBase64(match[2]);
  return raw && raw.length === 32 ? { version: match[1] ?? "1", raw } : null;
}

function keyRing(env: Record<string, unknown> | null | undefined): KeyRing | null {
  const current = parseCredentialKey(env?.PLATFORM_CREDENTIAL_KEY);
  if (!current) return null;
  const previous = parseCredentialKey(env?.PLATFORM_CREDENTIAL_KEY_PREVIOUS);
  // T-48 review: a previous key is kept even under the same version label (two
  // unprefixed keys are both "1"); decryption tries every key of that version.
  // Dropped only when it is the very same key: same version and same bytes
  // (`v1:A` → `v2:A` keeps A as version 1 so v1 envelopes still open).
  const same = previous && previous.version === current.version && previous.raw.length === current.raw.length && previous.raw.every((byte, index) => byte === current.raw[index]);
  return { current, previous: previous && !same ? previous : null };
}

/**
 * Bind this tenant's credential cipher to its database handle. Called where the
 * platform opens a tenant store; returns the handle for chaining.
 */
export function bindCredentials<T extends object>(database: T, tenantId: string, env: Record<string, unknown> | null | undefined): T {
  bindings.set(database, { tenantId, ring: tenantId ? keyRing(env) : null });
  return database;
}

/** Whether this handle can seal and open credentials (bound, with a usable key). */
export function credentialsAvailable(database: object | null | undefined): boolean {
  return Boolean(database && bindings.get(database)?.ring);
}

export function isSealedCredential(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// One derived key per (key version, tenant) per isolate; small and bounded.
const derived = new Map<string, Promise<CryptoKey>>();

function dataKey(root: RootKey, tenantId: string): Promise<CryptoKey> {
  const cacheKey = `${root.version}\u0000${encodeBase64Url(root.raw)}\u0000${tenantId}`;
  let key = derived.get(cacheKey);
  if (!key) {
    if (derived.size >= 512) derived.clear();
    key = crypto.subtle
      .importKey("raw", root.raw, "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(tenantId), info: INFO },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    key.catch(() => derived.delete(cacheKey));
    derived.set(cacheKey, key);
  }
  return key;
}

function additionalData(tenantId: string, column: string) {
  return new TextEncoder().encode(`${tenantId}\n${column}`);
}

/**
 * Encrypt one credential for this tenant and column. Empty stays empty (a
 * clear is a clear). Throws `CredentialKeyUnavailableError` rather than
 * returning plaintext when the handle has no key.
 */
export async function sealCredential(database: object, column: string, plaintext: string): Promise<string> {
  if (!plaintext) return plaintext;
  const binding = bindings.get(database);
  if (!binding?.ring) throw new CredentialKeyUnavailableError();
  const root = binding.ring.current;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(binding.tenantId, column) },
    await dataKey(root, binding.tenantId),
    new TextEncoder().encode(plaintext),
  );
  return `${PREFIX}${root.version}:${encodeBase64Url(iv)}:${encodeBase64Url(new Uint8Array(sealed))}`;
}

type Opened = { value: string; by: "current" | "previous" | "legacy" };

/** Open one stored value and say which key opened it (the sweep re-seals all but "current"). */
async function openDetailed(database: object | null | undefined, column: string, stored: unknown): Promise<Opened | null> {
  if (typeof stored !== "string" || !stored.trim()) return null;
  const binding = database ? bindings.get(database) : undefined;
  if (!binding?.ring) return null;
  // `enc:` is reserved: an envelope this code does not understand is unreadable,
  // never legacy plaintext (T-48 review).
  if (stored.startsWith("enc:") && !isSealedCredential(stored)) return null;
  if (!isSealedCredential(stored)) return { value: stored.trim(), by: "legacy" }; // the sweep seals it
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [version, ivText, bodyText] = parts;
  const iv = decodeBase64(ivText);
  const body = decodeBase64(bodyText);
  if (!iv || iv.length !== 12 || !body || body.length < 17) return null;
  const candidates: Array<[RootKey, Opened["by"]]> = [];
  if (binding.ring.current.version === version) candidates.push([binding.ring.current, "current"]);
  if (binding.ring.previous?.version === version) candidates.push([binding.ring.previous, "previous"]);
  for (const [root, by] of candidates) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(binding.tenantId, column) },
        await dataKey(root, binding.tenantId),
        body,
      );
      return { value: new TextDecoder().decode(plain), by };
    } catch {
      // try the next key of this version, if any
    }
  }
  // The column only: never the reason, which could help an attacker.
  console.warn("credential-unreadable", { column });
  return null;
}

/**
 * The plaintext of one stored credential, or null when there is none or it
 * cannot be read here: no binding, no key, a key this Worker does not hold, a
 * different tenant or column, a tampered value, or an unknown envelope. Never partial.
 */
export async function openCredential(database: object | null | undefined, column: string, stored: unknown): Promise<string | null> {
  return (await openDetailed(database, column, stored))?.value ?? null;
}

/**
 * The value to store instead, when this one is plaintext or opens only with
 * the previous key; null when it is already current or cannot be opened.
 */
export async function resealedCredential(database: object, column: string, stored: unknown): Promise<string | null> {
  const opened = await openDetailed(database, column, stored);
  if (!opened || opened.by === "current") return null;
  return sealCredential(database, column, opened.value);
}

/**
 * The one-time sweep (and the rotation step): seal every plaintext credential
 * in this store's `stores` row, and re-seal those under an older key version.
 * Each column is written only if it still holds the value read, so a save in
 * between is never overwritten. A value that cannot be opened is left as is.
 */
export async function encryptStoredCredentials(database: D1Database): Promise<{ sealed: number; skipped: boolean }> {
  if (!credentialsAvailable(database)) return { sealed: 0, skipped: true };
  const row = await database
    .prepare(`SELECT id, ${STORE_CREDENTIAL_COLUMNS.join(", ")} FROM stores ORDER BY id LIMIT 1`)
    .first<Record<string, unknown> & { id: number }>();
  if (!row) return { sealed: 0, skipped: false };
  let sealed = 0;
  for (const column of STORE_CREDENTIAL_COLUMNS) {
    const stored = row[column];
    const next = await resealedCredential(database, column, stored);
    if (next === null) continue;
    const result = await database
      .prepare(`UPDATE stores SET ${column} = ? WHERE id = ? AND ${column} = ?`)
      .bind(next, row.id, stored)
      .run();
    sealed += Number(result.meta?.changes ?? 0);
  }
  return { sealed, skipped: false };
}
