// T-40 (PR-25): the marketing site's metadata, structured data and the
// platform's own CompleteRegistration pair.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { platformSitePath, PLATFORM_SITE_ROUTES } from "./host.ts";
import { cookieValue, platformPixelId, registrationEventId, sendCompleteRegistration, siteJsonLd, SITE_PAGES } from "./site/site.ts";

test("every public path maps to a /platform page, with one trailing slash tolerated", () => {
  for (const [path, target] of Object.entries(PLATFORM_SITE_ROUTES)) {
    assert.ok(target.startsWith("/platform/") || target === "/platform/site", path);
    assert.equal(platformSitePath(path), target);
    if (path !== "/") assert.equal(platformSitePath(`${path}/`), target);
  }
  for (const path of ["/admin", "/produk/x", "/fitur/x", "//fitur", "/__proto__", "/constructor"]) assert.equal(platformSitePath(path), null, path);
  for (const page of Object.values(SITE_PAGES)) assert.ok(platformSitePath(page.path), `${page.path} has a route`);
});

test("titles and descriptions pass the copy QA gate and are unique", () => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const [key, page] of Object.entries(SITE_PAGES)) {
    assert.ok(page.title.length <= 70, `${key} title is ${page.title.length} characters`);
    assert.match(page.title, / - adsbook\.id$/, `${key} title suffix`);
    assert.ok(page.description.length >= 120 && page.description.length <= 155, `${key} description is ${page.description.length} characters`);
    assert.match(page.description, /\.$/, `${key} description ends with a full stop`);
    assert.doesNotMatch(page.title + page.description, /[|—]/, `${key}: separators`);
    titles.add(page.title);
    descriptions.add(page.description);
  }
  assert.equal(titles.size, Object.keys(SITE_PAGES).length);
  assert.equal(descriptions.size, Object.keys(SITE_PAGES).length);
});

test("JSON-LD names the organization and the application, claims no rating, and cannot close its script", async () => {
  const raw = siteJsonLd({ PLATFORM_SITE_URL: "https://adsbook.id" });
  assert.doesNotMatch(raw, /</);
  const data = JSON.parse(raw) as { "@graph": Array<Record<string, unknown>> };
  assert.deepEqual(data["@graph"].map((node) => node["@type"]), ["Organization", "SoftwareApplication"]);
  assert.doesNotMatch(raw, /aggregateRating|review|ratingValue/);
  // ADR-041 Option A, per store, in IDR — the same numbers billing charges.
  const offers = data["@graph"][1].offers as Array<{ name: string; price: string; priceCurrency: string }>;
  assert.deepEqual(offers.map((offer) => [offer.name, offer.price, offer.priceCurrency]), [
    ["1 Bulan", "149000", "IDR"], ["3 Bulan", "399000", "IDR"], ["6 Bulan", "759000", "IDR"], ["1 Tahun", "1490000", "IDR"],
  ]);
  const { BILLING_CYCLES } = await import("./billing.ts");
  assert.deepEqual(offers.map((offer) => Number(offer.price)), Object.values(BILLING_CYCLES).map((cycle) => cycle.amountIdr));
});

test("the platform Pixel id is read only when Pixel-shaped", () => {
  assert.equal(platformPixelId({}), null);
  assert.equal(platformPixelId({ PLATFORM_META_PIXEL_ID: "12345" }), null);
  assert.equal(platformPixelId({ PLATFORM_META_PIXEL_ID: "100000000000001" }), "100000000000001");
  assert.equal(platformPixelId({ PLATFORM_META_PIXEL_ID: "1000000000000x1" }), null);
});

test("CompleteRegistration from the server shares the browser's event id and hashes the email", async () => {
  const calls: Array<{ url: string; body: { data: Array<Record<string, unknown>>; test_event_code?: string } }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const env = { PLATFORM_META_PIXEL_ID: "100000000000001", PLATFORM_META_CAPI_TOKEN: "tok en", PLATFORM_META_TEST_EVENT_CODE: "TEST123" };
  const eventId = registrationEventId("2f0c8a8e-1f5b-4c9e-9a51-3c1f2b7d9e10");
  assert.equal(eventId, "2f0c8a8e-1f5b-4c9e-9a51-3c1f2b7d9e10");
  const result = await sendCompleteRegistration(env, { eventId, email: " Owner@Toko.Example ", phone: "6281234567890", sourceUrl: "https://adsbook.id/daftar", ip: "203.0.113.5", userAgent: "UA", fbp: "fb.1.1.2" }, fetcher);
  assert.equal(result, "sent");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/100000000000001\/events$/, "no token in the URL");
  assert.equal((calls[0].body as { access_token?: string }).access_token, "tok en");
  const event = calls[0].body.data[0];
  assert.equal(event.event_name, "CompleteRegistration");
  assert.equal(event.event_id, eventId);
  assert.equal(event.action_source, "website");
  assert.deepEqual((event.user_data as { em: string[] }).em, [createHash("sha256").update("owner@toko.example").digest("hex")]);
  assert.deepEqual((event.user_data as { ph: string[] }).ph, [createHash("sha256").update("6281234567890").digest("hex")]);
  assert.equal(calls[0].body.test_event_code, "TEST123");
  assert.doesNotMatch(JSON.stringify(calls[0].body), /Owner@Toko|owner@toko/, "no plain email leaves");
});

test("unset credentials send nothing; a failing Graph never throws into the signup", async () => {
  let called = false;
  const fetcher = (async () => ((called = true), new Response("{}", { status: 500 }))) as unknown as typeof fetch;
  const signal = { eventId: "abcdefgh", email: "a@b.co", sourceUrl: "https://adsbook.id/daftar", ip: null, userAgent: null };
  assert.equal(await sendCompleteRegistration({}, signal, fetcher), "skipped");
  assert.equal(await sendCompleteRegistration({ PLATFORM_META_PIXEL_ID: "100000000000001" }, signal, fetcher), "skipped");
  assert.equal(called, false);
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await sendCompleteRegistration({ PLATFORM_META_PIXEL_ID: "100000000000001", PLATFORM_META_CAPI_TOKEN: "t" }, signal, fetcher), "failed");
    const throwing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    assert.equal(await sendCompleteRegistration({ PLATFORM_META_PIXEL_ID: "100000000000001", PLATFORM_META_CAPI_TOKEN: "t" }, signal, throwing), "failed");
  } finally {
    console.error = original;
  }
  // A preparation error (here: a throwing signal) is contained too.
  const brokenSignal = () => { throw new URIError("malformed"); };
  console.error = () => undefined;
  try {
    assert.equal(await sendCompleteRegistration({ PLATFORM_META_PIXEL_ID: "100000000000001", PLATFORM_META_CAPI_TOKEN: "t" }, brokenSignal, fetcher), "failed");
  } finally {
    console.error = original;
  }
  assert.equal(cookieValue(new Request("https://adsbook.id/", { headers: { cookie: "_fbp=%E0%A4%A; _fbc=fb.1.2.abc" } }), "_fbp"), null, "a malformed cookie is no cookie");
  assert.equal(cookieValue(new Request("https://adsbook.id/", { headers: { cookie: "_fbp=%E0%A4%A; _fbc=fb.1.2.abc" } }), "_fbc"), "fb.1.2.abc");
  // A browser-supplied id that is not id-shaped is replaced, not forwarded.
  assert.notEqual(registrationEventId("<script>"), "<script>");
  assert.match(registrationEventId(undefined), /^[0-9a-f-]{36}$/);
});

test("no platform tag on seller hosts: platform tracking is referenced only from platform-host code", () => {
  const root = new URL("../", import.meta.url).pathname;
  // The console's health section names the platform Meta keys only to say whether they are set (T-52); it renders on the platform host alone.
  const allowed = [/^platform\/site\//, /^pages\/platform\//, /^pages\/api\/platform\/signup\.ts$/, /^components\/platform\/sections\/Health\.astro$/, /\.test\.ts$/, /^env\.d\.ts$/];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|astro)$/.test(name)) {
        const relative = full.slice(root.length);
        const source = readFileSync(full, "utf8");
        if (/PLATFORM_META_|PlatformPixel|platformPixelId|sendCompleteRegistration/.test(source) && !allowed.some((rule) => rule.test(relative))) offenders.push(relative);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test("T-51: no page claims the platform is free forever, and the pricing states one store per own domain", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const pages = readdirSync("src/pages/platform/site").filter((name) => name.endsWith(".astro")).map((name) => readFileSync(`src/pages/platform/site/${name}`, "utf8"));
  const site = [...pages, readFileSync("src/platform/site/content.ts", "utf8"), readFileSync("src/platform/site/site.ts", "utf8"), readFileSync("src/platform/site/Pricing.astro", "utf8")].join("\n");
  assert.doesNotMatch(site, /Rp0\b|gratis selamanya|Paket Pilot|price: "0"/i);
  assert.match(readFileSync("src/platform/site/Pricing.astro", "utf8"), /1 langganan = 1 toko dan 1 domain sendiri/);
  assert.match(site, /Bayar 10 bulan, gratis 2 bulan/);
});
