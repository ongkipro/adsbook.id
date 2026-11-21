import { isAdminRole, verifyPasswordHash } from './auth.ts';
import type { AdminRole } from './auth.ts';

export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD_HASH = 'pbkdf2-sha256$100000$-EwKzifD04qz0rRDZxAlpQ$Hq_4WkRnBcUgAASqRR0kukVbbGOZyN3IIxpvVfm6_l4';
const PASSWORD_ITERATIONS = 100_000;
/**
 * The shortest new seller password, the same floor as signup (`src/platform/signup.ts`)
 * and owner recovery (`src/platform/admin/recovery.ts`): a profile change or an
 * owner-set staff password may never be weaker than the password the store began
 * with. Existing passwords keep verifying whatever their length.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

type AdminCredentialRow = {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
  password_hash: string;
  must_change_password: number | boolean;
  updated_at: string;
};

export type AdminCredential = {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: AdminRole;
  passwordHash: string;
  mustChangePassword: boolean;
  updatedAt: string;
};

function encodeBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** IAM-10: the owner signs in with the signup email (≤254 characters). */
export const EMAIL_USERNAME_PATTERN = /^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/;

export function normalizeAdminUsername(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
}

/**
 * IAM-10: a username is the inherited staff form (`[a-z0-9._-]{3,64}`) or an
 * email address of at most 254 characters (the owner's signup email).
 */
export function validateAdminUsername(username: string) {
  if (USERNAME_PATTERN.test(username)) return true;
  return username.length <= 254 && EMAIL_USERNAME_PATTERN.test(username);
}

export function validateNewAdminPassword(password: string, username: string) {
  if (password.toLowerCase() === 'admin' || password.toLowerCase() === username.toLowerCase()) {
    return 'Password baru tidak boleh menggunakan username atau password default.';
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH || password.length > 128) return `Password baru harus berisi ${MIN_ADMIN_PASSWORD_LENGTH}–128 karakter.`;
  return '';
}

export function isDefaultAdminCredential(credential: Pick<AdminCredential, 'username' | 'passwordHash'>) {
  return credential.username === DEFAULT_ADMIN_USERNAME && credential.passwordHash === DEFAULT_ADMIN_PASSWORD_HASH;
}

/**
 * The seeded credential (`admin` + DEFAULT_ADMIN_PASSWORD_HASH) opens nothing
 * (T-21). A single-tenant install once accepted `admin` or a Worker-wide
 * BOOTSTRAP_ADMIN_PASSWORD for it until the operator rotated; on a platform
 * that is a known password on every tenant whose owner has not signed in yet,
 * and the forced password change it opened is an account takeover. A tenant's
 * owner credential is written at signup (T-26), never seeded.
 */
export async function verifyAdminLoginPassword(
  password: string,
  credential: Pick<AdminCredential, 'username' | 'passwordHash'>,
) {
  if (isDefaultAdminCredential(credential)) return false;
  return verifyPasswordHash(password, credential.passwordHash);
}

export async function hashAdminPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  ));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

export async function getAdminCredential(
  database: D1Database,
  username = DEFAULT_ADMIN_USERNAME,
): Promise<AdminCredential | null> {
  const normalizedUsername = normalizeAdminUsername(username);
  const row = await database.prepare(`
    SELECT id, username, display_name, email, role, password_hash,
      must_change_password, updated_at
    FROM admin_credentials
    WHERE username = ?
    LIMIT 1
  `).bind(normalizedUsername).first<AdminCredentialRow>();
  return credentialFromRow(row);
}

/** One credential by its id: adsbook.id/masuk signs in the credential its identifier names. */
export async function getAdminCredentialById(database: D1Database, id: number): Promise<AdminCredential | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = await database.prepare(`
    SELECT id, username, display_name, email, role, password_hash,
      must_change_password, updated_at
    FROM admin_credentials
    WHERE id = ?
    LIMIT 1
  `).bind(id).first<AdminCredentialRow>();
  return credentialFromRow(row);
}

function credentialFromRow(row: AdminCredentialRow | null): AdminCredential | null {
  if (!row || !isAdminRole(row.role)) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    mustChangePassword: Boolean(row.must_change_password),
    updatedAt: row.updated_at,
  };
}

export async function updateAdminCredential(
  database: D1Database,
  actorUsername: string,
  currentPassword: string,
  username: string,
  newPassword: string,
) {
  const current = await getAdminCredential(database, actorUsername);
  if (!current || !(await verifyPasswordHash(currentPassword, current.passwordHash))) {
    return { ok: false as const, error: 'Password saat ini salah.' };
  }

  const normalizedUsername = normalizeAdminUsername(username);
  if (!validateAdminUsername(normalizedUsername)) {
    return { ok: false as const, error: 'Pakai email, atau username 3–64 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.' };
  }
  const passwordError = validateNewAdminPassword(newPassword, normalizedUsername);
  if (passwordError) return { ok: false as const, error: passwordError };

  const passwordHash = await hashAdminPassword(newPassword);
  const updatedAt = new Date().toISOString();
  const result = await database.prepare(`
    UPDATE admin_credentials
    SET username = ?, password_hash = ?, must_change_password = 0, updated_at = ?
    WHERE id = ? AND password_hash = ?
  `).bind(
    normalizedUsername,
    passwordHash,
    updatedAt,
    current.id,
    current.passwordHash,
  ).run();
  if (result.meta.changes !== 1) {
    return { ok: false as const, error: 'Kredensial berubah di sesi lain. Muat ulang halaman dan coba kembali.' };
  }

  return { ok: true as const, username: normalizedUsername, updatedAt };
}
