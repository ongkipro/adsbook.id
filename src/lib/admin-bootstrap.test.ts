import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  hashAdminPassword,
  validateNewAdminPassword,
  verifyAdminLoginPassword,
} from "./admin-credentials.ts";

const seeded = {
  username: "admin",
  passwordHash: DEFAULT_ADMIN_PASSWORD_HASH,
};

// T-21: on the platform the seeded credential is a known password on every
// tenant whose owner has not signed in, and the forced password change it used
// to open is an account takeover. Signup writes the owner credential (T-26).
test("the seeded credential opens nothing, whatever password is tried", async () => {
  for (const password of ["admin", "Admin", "admin ", "", "password", "a-sufficiently-long-bootstrap"]) {
    assert.equal(await verifyAdminLoginPassword(password, seeded), false, JSON.stringify(password));
  }
});

test("a rotated credential opens with its own password only", async () => {
  const rotated = {
    username: "admin",
    passwordHash: await hashAdminPassword("a-real-operator-password"),
  };

  assert.equal(await verifyAdminLoginPassword("admin", rotated), false);
  assert.equal(await verifyAdminLoginPassword("a-real-operator-password", rotated), true);
});

test("the replacement password cannot be the default or the username", () => {
  assert.notEqual(validateNewAdminPassword("admin", "admin"), "");
  assert.notEqual(validateNewAdminPassword("ADMIN", "admin"), "");
  assert.notEqual(validateNewAdminPassword("owner", "owner"), "");
  assert.notEqual(validateNewAdminPassword("short", "admin"), "");
  assert.equal(validateNewAdminPassword("a-real-operator-password", "admin"), "");
});
