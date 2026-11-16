// T-28: cross-tenant cookie and cache isolation in a real browser
// (06-TENANT-ISOLATION §9: ISO-3, ISO-8, ISO-11, ISO-12; 07-IAM §11: AUTHZ-1, AUTHZ-4).
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM } from "./tenants.ts";

const A = origin("toko-alfa");
const B = origin("toko-beta");
const SESSION = "__Host-adsbook_session";

async function signIn(page: Page, base: string, slug: string) {
  const { username, password } = owner(slug);
  await page.goto(`${base}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(new RegExp(`^${base}/admin`));
}

test("ISO-3/AUTHZ-1/ISO-12: a seller session cookie is host-only and opens nothing on another store or the platform", async ({ page, context, browser }) => {
  await signIn(page, A, "toko-alfa");
  const session = (await context.cookies(A)).find((cookie) => cookie.name === SESSION);
  expect(session, "the session cookie").toBeTruthy();
  expect(session).toMatchObject({ domain: "toko-alfa.localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  expect((await context.cookies(B)).some((cookie) => cookie.name === SESSION)).toBe(false);
  expect((await context.cookies(PLATFORM)).some((cookie) => cookie.name === SESSION)).toBe(false);

  // B's admin, visited by A's owner in the same browser: B's login.
  await page.goto(`${B}/admin/orders`);
  await expect(page).toHaveURL(`${B}/hello`);

  // A's token replayed as a raw Cookie header (what a thief sends; the
  // browser itself refuses to plant a __Host- cookie for another host), on
  // B's host and, as a platform session, on the platform host (AUTHZ-4).
  const replay = await browser.newContext({
    extraHTTPHeaders: { cookie: `${SESSION}=${session!.value}; __Host-adsbook_platform=${session!.value}` },
  });
  const thief = await replay.newPage();
  await thief.goto(`${B}/admin/orders`);
  await expect(thief).toHaveURL(`${B}/hello`);
  const api = await thief.request.get(`${B}/api/admin/orders`);
  expect(api.status()).toBe(401);
  expect(await api.text()).not.toContain("Toko Alfa");
  await thief.goto(`${PLATFORM}/platform/tenants`);
  await expect(thief).toHaveURL(`${PLATFORM}/platform/login`);
  expect((await thief.request.get(`${PLATFORM}/api/platform/tenants`)).status()).toBe(401);
  await replay.close();
});

test("ISO-11: cookies tossed from store A for the parent domain leave store B's session intact and open nothing", async ({ page, context, browser }) => {
  await signIn(page, B, "toko-beta");
  const before = (await context.cookies(B)).find((cookie) => cookie.name === SESSION)!.value;

  // A script on A tries every cookie it could plant for B.
  await page.goto(`${A}/`);
  await page.evaluate(() => {
    document.cookie = "adsbook_session=forged; Domain=localhost; Path=/";
    document.cookie = "__Host-adsbook_session=forged; Domain=localhost; Path=/; Secure";
    document.cookie = "__Secure-adsbook_session=forged; Domain=localhost; Path=/; Secure";
  });
  const onB = await context.cookies(B);
  expect(onB.find((cookie) => cookie.name === SESSION)?.value).toBe(before);
  expect(onB.some((cookie) => cookie.value === "forged" && cookie.name.startsWith("__Host-"))).toBe(false);
  await page.goto(`${B}/admin/orders`);
  await expect(page).toHaveURL(`${B}/admin/orders`);

  // The tossed cookies alone, in a fresh browser: B's login.
  const stranger = await browser.newContext();
  await stranger.addCookies([{ name: "adsbook_session", value: before, domain: ".localhost", path: "/" }]);
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(`${B}/admin/orders`);
  await expect(strangerPage).toHaveURL(`${B}/hello`);
  await stranger.close();
});

test("ISO-8 and ADR-029: an anonymous page is cached per host, never across stores and never with a cookie", async ({ request }) => {
  const first = await request.get(`${A}/`);
  expect(first.status()).toBe(200);
  const second = await request.get(`${A}/`);
  expect(second.headers()["x-edge-cache"]).toBe("HIT");
  expect(second.headers()["set-cookie"]).toBeUndefined();
  expect(await second.text()).toContain("Toko Alfa");

  // Same path, other store: B's own page, not A's cached copy.
  const other = await request.get(`${B}/`);
  expect(other.status()).toBe(200);
  expect(other.headers()["x-edge-cache"]).not.toBe("HIT");
  const otherHtml = await other.text();
  expect(otherHtml).toContain("Toko Beta");
  expect(otherHtml).not.toContain("Toko Alfa");
});

test("ADR-029: admin pages are never cacheable, and logging out deletes the __Host- cookie", async ({ page, context }) => {
  await signIn(page, A, "toko-alfa");
  const admin = await page.request.get(`${A}/admin/orders`);
  expect(admin.headers()["cache-control"] ?? "").toContain("no-store");
  expect(admin.headers()["x-edge-cache"]).toBeUndefined();

  const status = await page.evaluate(async () => (await fetch("/api/admin/logout", { method: "POST" })).status);
  expect(status).toBeLessThan(400);
  expect((await context.cookies(A)).some((cookie) => cookie.name === SESSION)).toBe(false);
  await page.goto(`${A}/admin/orders`);
  await expect(page).toHaveURL(`${A}/hello`);
});
