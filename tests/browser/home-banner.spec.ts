// R1b: the manual home banner from "Tampilan toko", end to end on a seeded store.
//   1. A banner saved to the draft is invisible to buyers; the signed-in preview
//      shows it (private, no-store, noindex) and the publish stores exactly the
//      slides the preview rendered.
//   2. The same preview URL, anonymous or from another store's session, is the
//      public page: no bar, no draft image, never served from the edge cache.
//   3. A store's banner image does not exist on another store's host.
//   4. Removing the banner returns the hero to the catalogue rotation.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const [store, other] = TENANTS;

async function signIn(page: Page, slug: string) {
  const creds = owner(slug);
  await page.goto(`${origin(slug)}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

/** A 600x600 PNG drawn in the page, so the upload runs the real admin image pipeline. */
async function bannerFile(page: Page, colour: string) {
  const base64 = await page.evaluate((colour) => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = colour;
    context.fillRect(0, 0, 600, 600);
    return canvas.toDataURL("image/png").split(",")[1];
  }, colour);
  return { name: "banner-uji.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

const heroImages = (html: string) => [...html.matchAll(/aria-roledescription="slide"[\s\S]*?<img[^>]*?src="([^"]+)"/g)].map((match) => match[1]);

test("a banner goes draft → exact private preview → publish, and is removed back to the catalogue", async ({ page, request }) => {
  test.setTimeout(90_000);
  await signIn(page, store.slug);
  await page.goto(`${origin(store.slug)}/admin/content/tampilan`);
  await expect(page.getByText(/Versi \d+\./)).toBeVisible();

  // 1. Draft: upload through the media pipeline, alt text, save.
  await page.getByLabel("Pilih gambar banner").setInputFiles(await bannerFile(page, "#1d4ed8"));
  await page.getByRole("button", { name: "Unggah gambar" }).click();
  await expect(page.getByText(/^Gambar: \/media\/content\//)).toBeVisible();
  const image = (await page.getByText(/^Gambar: \/media\/content\//).textContent())!.replace("Gambar: ", "").trim();
  await page.getByLabel("Teks alternatif (wajib)").fill("Banner uji biru");
  await page.getByRole("button", { name: /banner draft$/ }).first().click();
  await expect(page.locator("figure", { hasText: "Banner di draft" }).locator("img")).toHaveAttribute("src", image);

  const publicBefore = await request.get(`${origin(store.slug)}/`);
  expect(heroImages(await publicBefore.text()), "a draft is not public").not.toContain(image);

  // 2. Preview: the signed-in operator sees the projection, privately.
  // A fresh store has nothing published: the offer is "Terbitkan banner draft" (insert-first).
  const row = page.locator('[data-publish-op="insert-first"]');
  await expect(row).toContainText("Terbitkan banner draft");
  const previewHref = (await row.getByRole("link", { name: "Pratinjau" }).getAttribute("href"))!;
  const preview = await page.context().request.get(`${origin(store.slug)}${previewHref}`);
  const previewHtml = await preview.text();
  expect(preview.headers()["cache-control"]).toContain("no-store");
  expect(preview.headers()["cache-control"]).toContain("private");
  expect(preview.headers()["x-robots-tag"]).toContain("noindex");
  expect(previewHtml).toMatch(/<meta[^>]+name="robots"[^>]+noindex/);
  expect(previewHtml).toContain("data-banner-preview");
  const previewed = heroImages(previewHtml);
  expect(previewed[0]).toBe(image);
  // The LCP preload names the same first slide the preview renders.
  expect(previewHtml).toContain(`<link rel="preload" as="image" href="${image}"`);

  // The same URL for anyone else: the public page, nothing of the draft, never a cached copy.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const anonymous = await request.get(`${origin(store.slug)}${previewHref}`);
    const html = await anonymous.text();
    expect(html).not.toContain("data-banner-preview");
    expect(heroImages(html)).not.toContain(image);
    expect(anonymous.headers()["x-edge-cache"] ?? "", "a preview URL is never served from the edge cache").not.toBe("HIT");
  }

  // 3. Another store's host: the image does not exist there; this session previews nothing there.
  expect((await request.get(`${origin(other.slug)}${image}`)).status()).toBe(404);
  const elsewhere = await page.context().request.get(`${origin(other.slug)}${previewHref}`);
  expect(await elsewhere.text()).not.toContain("data-banner-preview");

  // Publish with the previewed op and version: the stored slides are the previewed ones.
  await row.getByRole("button", { name: "Terbitkan" }).click();
  await expect(page.locator("figure", { hasText: "Banner terbit" }).locator("img")).toHaveAttribute("src", image);
  const published = await page.evaluate(async () => (await (await fetch("/api/admin/content?key=home")).json()).data.published.heroSlides);
  expect(published.map((slide: { image: string }) => slide.image)).toEqual(previewed);
  const live = await request.get(`${origin(store.slug)}/`);
  const liveHtml = await live.text();
  expect(heroImages(liveHtml)[0]).toBe(image);
  expect(liveHtml, "the public page preloads the published banner").toContain(`<link rel="preload" as="image" href="${image}"`);

  // 4. Remove the published banner: the hero falls back to the catalogue rotation.
  const removal = page.locator('[data-publish-op="remove-first"]');
  await expect(removal).toContainText("Hapus banner terbit");
  await removal.getByRole("button", { name: "Terbitkan" }).click();
  await expect(page.locator("figure", { hasText: "Banner terbit" })).toContainText("Tidak ada banner");
  const fallback = heroImages(await (await request.get(`${origin(store.slug)}/`)).text());
  expect(fallback.length).toBeGreaterThan(0);
  expect(fallback).not.toContain(image);
});

// Review (R1b): the banner preview is a seller tool, not buyer traffic. With
// test tag ids on a subscribed store, the public home carries every buyer tag
// and fires them; the authorized preview — current or stale — carries none and
// fires nothing. Every provider host and the store's own event relays are
// answered here, so no request ever leaves the machine.
const TAGS = { meta: "123456789012345", gtm: "GTM-TESTR1B", googleAds: "AW-1234567890", googleLabel: "r1bTestLabel", tiktok: "C4TESTRIBPREVIEW" };
const PROVIDER_HOSTS = /^https:\/\/([^/]+\.)?(facebook\.net|facebook\.com|googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net|google\.com|tiktok\.com|tiktokw\.us)\//;

test("buyer ad tags load on the public home of a subscribed store and never on the banner preview", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const base = origin(other.slug);
  await signIn(page, other.slug);
  const admin = (body: Record<string, unknown>) =>
    page.evaluate(async (body) => {
      const response = await fetch("/api/admin/ads", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    }, body);

  try {
    // Opted-in local fixture: test ids only, no CAPI or Events API token.
    expect(await admin({ action: "save-meta", meta_pixel_id: TAGS.meta })).toBe(200);
    expect(await admin({ action: "save-google", google_tag_manager_id: TAGS.gtm, google_ads_conversion_id: TAGS.googleAds, google_ads_conversion_label: TAGS.googleLabel })).toBe(200);
    expect(await admin({ action: "save-tiktok", tiktok_pixel_id: TAGS.tiktok })).toBe(200);

    // A draft banner to preview.
    await page.goto(`${base}/admin/content/tampilan`);
    await page.getByLabel("Pilih gambar banner").setInputFiles(await bannerFile(page, "#047857"));
    await page.getByRole("button", { name: "Unggah gambar" }).click();
    await expect(page.getByText(/^Gambar: \/media\/content\//)).toBeVisible();
    await page.getByLabel("Teks alternatif (wajib)").fill("Banner uji pelacakan");
    await page.getByRole("button", { name: /banner draft$/ }).first().click();
    await expect(page.locator('[data-publish-op="insert-first"]')).toBeVisible();
    const previewHref = (await page.locator('[data-publish-op="insert-first"]').getByRole("link", { name: "Pratinjau" }).getAttribute("href"))!;

    /** Loads `url` in `context`, answering every provider and relay request locally; returns html and what was attempted. */
    const visit = async (context: import("@playwright/test").BrowserContext, url: string) => {
      const attempted: string[] = [];
      await context.route(PROVIDER_HOSTS, (route) => {
        attempted.push(route.request().url());
        return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
      });
      await context.route(/\/api\/(meta-event|tiktok-event)$/, (route) => {
        attempted.push(route.request().url());
        return route.fulfill({ status: 200, json: { success: true } });
      });
      const tab = await context.newPage();
      const response = await tab.goto(url, { waitUntil: "load" });
      // The tag libraries load on the first interaction or after 2.5 s, and the
      // Meta init can wait 4 s: interact, then outlast every timer, on both pages.
      await tab.keyboard.press("Tab");
      await tab.mouse.wheel(0, 200);
      await tab.waitForTimeout(4_500);
      const html = await tab.content();
      await tab.close();
      await context.unrouteAll({ behavior: "ignoreErrors" });
      return { html, attempted, headers: response!.headers() };
    };

    // Public home, anonymous buyer: every tag present and fired.
    const buyer = await browser.newContext();
    const publicHome = await visit(buyer, `${base}/`);
    for (const id of Object.values(TAGS).filter((id) => id !== TAGS.googleLabel)) expect(publicHome.html, `public home carries ${id}`).toContain(id);
    expect(publicHome.html).toContain('href="https://connect.facebook.net"');
    expect(publicHome.html).toContain('href="https://www.googletagmanager.com"');
    expect(publicHome.html).toContain(`googletagmanager.com/ns.html?id=${TAGS.gtm}`);
    expect(publicHome.attempted.some((url) => url.includes("facebook.net")), "Meta library requested").toBe(true);
    expect(publicHome.attempted.some((url) => url.includes("googletagmanager.com")), "Google tag requested").toBe(true);
    expect(publicHome.attempted.some((url) => url.includes("tiktok")), "TikTok library requested").toBe(true);
    expect(publicHome.attempted.some((url) => url.endsWith("/api/meta-event")), "PageView relayed").toBe(true);
    await buyer.close();

    // Authorized preview, current and stale: the bar, and no buyer tag of any kind.
    for (const href of [previewHref, previewHref.replace(/v=\d+/, "v=999")]) {
      const preview = await visit(page.context(), `${base}${href}`);
      expect(preview.html).toContain("data-banner-preview");
      expect(preview.headers["cache-control"]).toContain("no-store");
      for (const id of Object.values(TAGS)) expect(preview.html, `preview carries no ${id}`).not.toContain(id);
      for (const host of ["connect.facebook.net", "googletagmanager.com", "googleadservices.com", "analytics.tiktok.com", "/api/meta-event", "/api/tiktok-event"]) {
        expect(preview.html, `preview names no ${host}`).not.toContain(host);
      }
      expect(preview.attempted, `${href}: nothing sent to a provider or a relay`).toEqual([]);
    }
  } finally {
    await admin({ action: "save-meta", meta_pixel_id: "" });
    await admin({ action: "save-google", google_tag_manager_id: "", google_ads_conversion_id: "", google_ads_conversion_label: "" });
    await admin({ action: "save-tiktok", tiktok_clear: true });
  }
});
