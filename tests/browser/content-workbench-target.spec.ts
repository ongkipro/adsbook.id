// R1a review finding: ContentWorkbench used to set the picked target before its
// read succeeded, so a slow or failed read left the new key paired with the
// previous target's document and version, with the write buttons live.
//
// Proves in Chromium, on an ordinary seeded store, that a write only ever goes
// to the target the editor has loaded:
//   1. While a target read is pending, Generate / Simpan Draft / Publish are
//      disabled and no PUT is sent.
//   2. When that read fails, the picker falls back to the loaded target, the
//      unsaved text stays, and a save goes to that target with its own version.
//   3. When a (slow) read succeeds, the next save carries the new key and the
//      new target's version.
// Every PUT is intercepted and answered by the test, so the fixture's content
// rows are never written.
import { expect, test, type Page, type Route } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const store = TENANTS[0];

async function signIn(page: Page) {
  const creds = owner(store.slug);
  await page.goto(`${origin(store.slug)}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

const contentVersion = (page: Page, key: string) =>
  page.evaluate(async (key) => {
    const payload = await (await fetch(`/api/admin/content?key=${encodeURIComponent(key)}`)).json();
    return (payload.data?.version as number | undefined) ?? 0;
  }, key);

test("a content write only goes to the target the editor has loaded", async ({ page }) => {
  await signIn(page);
  const writes: Array<{ action: string; key: string; expectedVersion: number }> = [];
  await page.route(
    (url) => url.pathname === "/api/admin/content",
    async (route: Route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      const body = JSON.parse(route.request().postData() || "{}");
      writes.push({ action: body.action, key: body.key, expectedVersion: body.expectedVersion });
      await route.fulfill({ status: 503, json: { success: false, error: "Ditahan oleh uji." } });
    },
  );

  await page.goto(`${origin(store.slug)}/admin/content`);
  const editor = page.getByRole("textbox", { name: "Draft JSON" });
  const save = page.getByRole("button", { name: "Simpan Draft" });
  const generate = page.getByRole("button", { name: "Generate Workers AI" });
  const publish = page.getByRole("button", { name: "Publish Draft" });
  const picker = page.locator('[aria-label="Target konten"]');
  await expect(page.getByText(/^Versi \d+/)).toBeVisible();
  await expect(picker).toHaveText(/Homepage/);
  const homeVersion = await contentVersion(page, "home");

  const unsaved = '{"belumDisimpan": true}';
  await editor.fill(unsaved);

  // 1–2. A product read that is held, then fails.
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => (releaseRead = resolve));
  await page.route(/\/api\/admin\/content\?key=product%3A/, async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { success: false, error: "Gagal memuat target (uji)." } });
  });
  await picker.click();
  const productOption = page.getByRole("option", { name: /Product ID \d+/ }).first();
  const productLabel = (await productOption.textContent())!.trim();
  const productKey = `product:${productLabel.match(/Product ID (\d+)/)![1]}`;
  await productOption.click();

  await expect(save).toBeDisabled();
  await expect(generate).toBeDisabled();
  await expect(publish).toBeDisabled();
  await save.click({ force: true });
  await generate.click({ force: true });
  expect(writes).toEqual([]);
  await expect(page.getByRole("status").filter({ hasText: "Memuat target…" })).toBeVisible();

  releaseRead();
  await expect(page.getByText("Gagal memuat target (uji).")).toBeVisible();
  await expect(picker).toHaveText(/Homepage/);
  await expect(editor).toHaveValue(unsaved);
  await expect(page.getByText(`Versi ${homeVersion}`, { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();

  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ action: "save-draft", key: "home", expectedVersion: homeVersion });

  // 3. The same product read, slow but successful: the next write targets it.
  await page.unroute(/\/api\/admin\/content\?key=product%3A/);
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  await page.route(/\/api\/admin\/content\?key=product%3A/, async (route) => {
    await slow;
    await route.fallback();
  });
  await picker.click();
  await page.getByRole("option", { name: productLabel }).click();
  await expect(save).toBeDisabled();
  expect(writes).toHaveLength(1);
  releaseSlow();
  await expect(picker).toHaveText(productLabel);
  await expect(save).toBeEnabled();
  const productVersion = await contentVersion(page, productKey);
  await expect(page.getByText(`Versi ${productVersion}`, { exact: true })).toBeVisible();

  await save.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ action: "save-draft", key: productKey, expectedVersion: productVersion });
});
