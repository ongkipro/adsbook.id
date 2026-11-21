import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  hashAdminPassword,
  isDefaultAdminCredential,
  normalizeAdminUsername,
  validateAdminUsername,
  validateNewAdminPassword,
  verifyAdminLoginPassword,
} from './admin-credentials.ts';
import { canAccessAdminRoute, isAdminRole, secureEqual, verifyPasswordHash, type AdminRole } from './auth.ts';

/**
 * Reversed twice. 2026-08-16 let `admin` open the seeded credential so a fresh
 * single-tenant install was reachable at all (LOGIN-1…5). T-21 closes it again:
 * a platform tenant has no installer, its owner credential is written at
 * signup, and a seeded credential that opened anything would be a known
 * password on every tenant not yet claimed.
 */
test('the seeded default credential is recognised and opens nothing (T-21)', async () => {
  const defaultCredential = {
    username: 'admin',
    passwordHash: DEFAULT_ADMIN_PASSWORD_HASH,
  };
  assert.equal(isDefaultAdminCredential(defaultCredential), true);
  assert.equal(await verifyAdminLoginPassword('admin', defaultCredential), false);
});

test('new password hashes use random salts and verify through the login contract', async () => {
  const first = await hashAdminPassword('safe-password-123');
  const second = await hashAdminPassword('safe-password-123');
  assert.notEqual(first, second);
  assert.equal(await verifyPasswordHash('safe-password-123', first), true);
  assert.equal(await verifyPasswordHash('safe-password-124', first), false);
});

/**
 * LOGIN-13. The login screen levels its response time by running a discarded
 * verification against DEFAULT_ADMIN_PASSWORD_HASH whenever the real path would
 * be cheap — an unknown username, or the seeded credential's digest compare.
 * That only hides the difference while the constant is a verification the
 * runtime will actually perform: `verifyPasswordHash` returns false immediately
 * for a hash it cannot parse, so a malformed or weakened constant would turn
 * the floor back into free work and restore the leak without failing anything
 * else. This pins the constant, not the page.
 */
test('the login timing work floor is a real PBKDF2 verification', async () => {
  const [algorithm, iterations] = DEFAULT_ADMIN_PASSWORD_HASH.split('$');
  assert.equal(algorithm, 'pbkdf2-sha256');
  assert.ok(Number(iterations) >= 100_000, 'the floor must cost at least the product minimum');

  // Not short-circuited: a wrong password still runs the derivation and returns false.
  assert.equal(await verifyPasswordHash('not-the-seeded-password', DEFAULT_ADMIN_PASSWORD_HASH), false);

  // Medians of several runs, not one measurement each. The digest compare takes
  // a few hundredths of a millisecond, so a single GC pause or a busy CI runner
  // landing inside that one sample inflated it past floorCost / 10 and failed
  // the suite with nothing wrong in the code. A median ignores the outliers a
  // shared machine produces and still moves with a floor that became free work.
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
  const measure = async (runs: number, work: () => Promise<unknown>) => {
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await work();
      samples.push(performance.now() - start);
    }
    return median(samples);
  };
  const floorCost = await measure(5, () => verifyPasswordHash('not-the-seeded-password', DEFAULT_ADMIN_PASSWORD_HASH));
  const compareCost = await measure(9, () => secureEqual('not-the-seeded-password', 'admin'));

  assert.ok(
    floorCost > compareCost * 10,
    `the floor (${floorCost.toFixed(2)}ms) must dominate the digest compare it hides (${compareCost.toFixed(2)}ms)`,
  );
});

test('admin usernames are normalized and restricted to URL-safe characters', () => {
  assert.equal(normalizeAdminUsername('  Paduka.Admin  '), 'paduka.admin');
  assert.equal(validateAdminUsername('paduka.admin'), true);
  assert.equal(validateAdminUsername('paduka admin'), false);
  assert.equal(validateAdminUsername('ab'), false);
});

test('new admin passwords reject weak defaults', () => {
  assert.equal(validateNewAdminPassword('abc', 'admin'), 'Password baru harus berisi 10–128 karakter.');
  assert.equal(validateNewAdminPassword('admin', 'admin'), 'Password baru tidak boleh menggunakan username atau password default.');
});

test('a new seller password is never weaker than signup and owner recovery: 10–128, checked at the boundary', async () => {
  const signup = readFileSync(new URL('../platform/signup.ts', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('../platform/admin/recovery.ts', import.meta.url), 'utf8');
  assert.match(signup, /password\.length < 10 \|\| password\.length > 128/, 'signup floor is 10');
  assert.match(recovery, /next\.length < 10 \|\| next\.length > 128/, 'IAM-9 floor is 10');
  const message = 'Password baru harus berisi 10–128 karakter.';
  assert.equal(validateNewAdminPassword('a'.repeat(9), 'kasir'), message, '9 refused');
  assert.equal(validateNewAdminPassword('a'.repeat(10), 'kasir'), '', '10 accepted');
  assert.equal(validateNewAdminPassword('a'.repeat(128), 'kasir'), '', '128 accepted');
  assert.equal(validateNewAdminPassword('a'.repeat(129), 'kasir'), message, '129 refused');
  assert.notEqual(validateNewAdminPassword('kasir-toko', 'kasir-toko'), '', 'the username is still refused at any length');
  // The seller forms ask for the same floor before submitting.
  const profile = readFileSync(new URL('../pages/admin/profile.astro', import.meta.url), 'utf8');
  const access = readFileSync(new URL('../components/admin/AccessManager.tsx', import.meta.url), 'utf8');
  assert.equal((profile.match(/minlength="10"/g) ?? []).length, 2, 'profile: new and confirm fields');
  assert.match(profile, /minimal 10 karakter/);
  assert.equal((access.match(/minLength=\{10\}/g) ?? []).length, 2, 'staff create and staff reset');
  assert.match(access, /Minimal 10 karakter/);
  const help = readFileSync(new URL('../components/admin/docs/DocsAdminChapter.astro', import.meta.url), 'utf8');
  assert.match(help, /password \(minimal 10 karakter, tidak sama dengan username\)/, 'in-app help says the same');
  assert.ok(!/minlength="8"|minLength=\{8\}|[Mm]inimal 8 karakter/.test(profile + access + help), 'no 8-character floor left');
});

test('existing shorter passwords keep signing in: the floor applies to new passwords only', async () => {
  for (const legacy of ['kasir123', 'pemilik99']) {
    const credential = { username: 'kasir', passwordHash: await hashAdminPassword(legacy) };
    assert.equal(await verifyAdminLoginPassword(legacy, credential), true, `${legacy.length} characters still verify`);
    assert.equal(await verifyAdminLoginPassword(`${legacy}x`, credential), false);
  }
});

test("operator roles use one deny-by-default route policy", () => {
  assert.equal(isAdminRole("owner"), true);
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("advertiser"), true);
  assert.equal(isAdminRole("customer_service"), true);
  assert.equal(isAdminRole("guest" as AdminRole), false);

  assert.equal(canAccessAdminRoute("owner", "/admin/settings"), true);
  assert.equal(canAccessAdminRoute("admin", "/admin/settings"), true);
  assert.equal(canAccessAdminRoute("advertiser", "/admin/settings"), false);
  assert.equal(canAccessAdminRoute("customer_service", "/admin/orders"), true);
  assert.equal(canAccessAdminRoute("customer_service", "/admin/settings"), false);
  assert.equal(canAccessAdminRoute("advertiser", "/admin/content"), true);
  assert.equal(canAccessAdminRoute("advertiser", "/admin/products"), true);
});
