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

test("brand: the site uses the blue wordmark files and blue tokens; the animated logo respects reduced motion", async () => {
  const { existsSync } = await import("node:fs");
  const layout = readFileSync("src/platform/site/SiteLayout.astro", "utf8");
  for (const file of ["adsbook-id-wordmark.svg", "adsbook-id-wordmark-on-dark.svg", "adsbook-id-wordmark-animated.svg", "adsbook-id-mark-on-accent.svg"]) {
    assert.ok(existsSync(`public/platform/brand/${file}`), file);
  }
  assert.match(layout, /\/platform\/brand\/adsbook-id-wordmark\.svg/, "header logo");
  assert.match(layout, /\/platform\/brand\/adsbook-id-wordmark-on-dark\.svg/, "footer logo");
  assert.match(layout, /--accent: #2563eb;/i, "blue accent");
  assert.doesNotMatch(layout + readFileSync("src/pages/platform/signup.astro", "utf8"), /#c2410c|#9a3412|#fed7aa|#faf7f2/i, "no orange brand left");
  const animated = readFileSync("public/platform/brand/adsbook-id-wordmark-animated.svg", "utf8");
  assert.match(animated, /prefers-reduced-motion: reduce/);
  for (const name of ["rise l0", "rise l6", "rise id", "streak browser", "streak server", "dot", "lock"]) assert.ok(animated.includes(`class="${name}"`), name);
  // The precision rule: the dot is one 150-unit module, 60 units from k and from i.
  const wordmark = readFileSync("public/platform/brand/adsbook-id-wordmark.svg", "utf8");
  assert.match(wordmark, /fill="#2563EB"/i);
  const band = readFileSync("src/platform/site/SignalBand.astro", "utf8");
  assert.match(band, /prefers-reduced-motion: reduce/, "the brand band plays the logo only when motion is allowed");
});

test("one site: every marketing page uses the shared frame, ends its title on the brand dot, and links to signup", async () => {
  const { PILLARS, CAPABILITIES, FAQ_GROUPS, FAQ_SHORT, FAQ_MORE } = await import("./site/content.ts");
  const pages = ["index", "coba", "fitur", "cara-kerja", "harga", "faq", "kontak"];
  for (const name of pages) {
    const source = readFileSync(`src/pages/platform/site/${name}.astro`, "utf8");
    assert.match(source, /<SiteLayout page=\{SITE_PAGES\./, `${name}: the shared frame`);
    assert.match(source, /class="dot-end"|<PageHead /, `${name}: the h1 ends on the dot`);
    assert.match(source, /<ClosingCta|SIGNUP_PATH|<Pricing/, `${name}: a way to sign up`);
  }
  // The home and /coba show the same pillars that /fitur details; every pillar has a screen or numbers.
  assert.equal(PILLARS.length, 6);
  assert.equal(new Set(PILLARS.map((pillar) => pillar.id)).size, 6);
  for (const pillar of PILLARS) assert.ok(pillar.shot || pillar.specs?.length, pillar.id);
  assert.ok(CAPABILITIES.length >= 6);
  // All ad channels, not one network (Paduka, 2026-11-17): the signal pillar names them, and the
  // channels it names are the ones Analitik reports (AD_CHANNEL_LABELS).
  const { AD_CHANNEL_LABELS } = await import("../lib/ad-channel.ts");
  const signal = PILLARS.find((pillar) => pillar.id === "sinyal")!;
  for (const channel of [AD_CHANNEL_LABELS.meta, AD_CHANNEL_LABELS.google, AD_CHANNEL_LABELS.tiktok]) {
    assert.ok(signal.points.join(" ").includes(channel), `the signal pillar names ${channel}`);
  }
  assert.match(readFileSync("src/pages/platform/site/index.astro", "utf8"), /semua platform iklan|semua ad platform|semua kanal/i, "the home says every ad platform");
  // Every FAQ answer appears exactly once in the grouped FAQ.
  const grouped = FAQ_GROUPS.flatMap((group) => group.items);
  assert.equal(grouped.length, FAQ_SHORT.length + FAQ_MORE.length);
  assert.equal(new Set(grouped).size, grouped.length);
  // Product language: no infrastructure vendor named in the marketing copy (Paduka, 2026-11-17).
  // Rendered copy only: string literals in content.ts and the markup text of each page.
  const strings = [...readFileSync("src/platform/site/content.ts", "utf8").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const markup = pages.map((name) => readFileSync(`src/pages/platform/site/${name}.astro`, "utf8").split("---").slice(2).join("---").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|\{[^}]*\}|<[^>]+>/g, " "));
  assert.doesNotMatch([...strings, ...markup].join("\n"), /Cloudflare|\bAstro\b|Durable Object/);
});


test("home 3D hero (Paduka, 2026-11-18): three loads on the home alone, from our own bundle, with real links and calm motion", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|astro|mjs|js)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
  const sources = [...files("src"), ...files("scripts")].map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const using = (pattern: RegExp) => sources.filter((file) => pattern.test(file.text)).map((file) => file.path).sort();
  // Seller storefronts, the admin and the inner pages never fetch a byte of it.
  assert.deepEqual(using(/from ["']three["']|import\(["']three["']\)/), ["src/platform/site/kinetic-stage.ts"]);
  assert.deepEqual(using(/import\(?\s*["']\.\/kinetic-stage/), ["src/platform/site/KineticHero3D.astro"]);
  assert.deepEqual(using(/import KineticHero3D|<KineticHero3D/), ["src/pages/platform/site/index.astro"]);

  const hero = readFileSync("src/platform/site/KineticHero3D.astro", "utf8");
  const stage = readFileSync("src/platform/site/kinetic-stage.ts", "utf8");
  assert.doesNotMatch(hero + stage, /https?:\/\//, "no CDN, font service or remote asset");
  assert.match(hero, /href=\{SIGNUP_PATH\}/, "the CTA is a real /daftar link");
  // The account button and its dialog live in the shared header, which the hero renders too.
  const header = readFileSync("src/platform/site/SiteHeader.astro", "utf8");
  assert.match(hero, /<SiteHeader variant="hero"/, "the hero uses the shared header");
  assert.doesNotMatch(header, /https?:\/\//, "the header loads nothing remote");
  assert.match(header, /id="btn-user-auth"[^>]*href="\/masuk"|href="\/masuk"[^>]*id="btn-user-auth"/, "the account button is a real /masuk link");
  assert.match(hero, /touch-action: pan-y/, "a swipe on the stage still scrolls the page");
  assert.match(stage, /prefers-reduced-motion: reduce/);
  assert.match(stage, /IntersectionObserver/, "no frame is drawn while the hero is off screen");
  assert.match(stage, /visibilityState/);

  const home = readFileSync("src/pages/platform/site/index.astro", "utf8");
  assert.match(home, /<SiteLayout page=\{SITE_PAGES\.home\} heroHeader>/);
  assert.equal(home.match(/<h1\b/g)?.length, 1, "one h1, the hero's");
  assert.match(home, /<h2 id="bukti-produk-title">/, "the former hero is the second section");
  assert.match(home, /<ShotFrame shot=\{SHOTS\.form\} caption \/>/, "below the fold the screenshot loads lazily");
  // The email the hero dialog hands to /daftar never rides in a URL (the platform Pixel reports page URLs).
  assert.doesNotMatch(hero, /name="email"/);
});

test("tracking proof (pagecopy v3): simulations are captioned illustrations of mechanisms the code has, and calm in motion", async () => {
  const band = readFileSync("src/platform/site/SignalBand.astro", "utf8");
  const strip = readFileSync("src/platform/site/SignalPipelineStrip.astro", "utf8");
  const geo = readFileSync("src/platform/site/HybridGeoSim.astro", "utf8");
  const bento = readFileSync("src/platform/site/HomeBentoGrid.astro", "utf8");
  const compare = readFileSync("src/platform/site/CompetitorCompare.astro", "utf8");
  const campaigns = readFileSync("src/platform/site/TopCampaignsShowcase.astro", "utf8");
  for (const [name, source] of [["SignalBand", band], ["SignalPipelineStrip", strip], ["HybridGeoSim", geo], ["HomeBentoGrid", bento], ["TopCampaignsShowcase", campaigns]] as const) {
    assert.match(source, /@media \(prefers-reduced-motion: reduce\)/, `${name}: CSS holds still under reduced motion`);
    assert.match(source, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/, `${name}: the script never starts the loop under reduced motion`);
    assert.match(source, /IntersectionObserver/, `${name}: plays only on screen`);
    assert.doesNotMatch(source, /https?:\/\//, `${name}: no remote asset`);
  }
  assert.doesNotMatch(compare, /https?:\/\//, "CompetitorCompare: no remote asset");
  assert.equal((band.match(/class="sim-caption">Ilustrasi /g) ?? []).length, 2, "both simulations say they are illustrations");
  assert.match(geo, /class="geo-caption">Ilustrasi /, "HybridGeoSim says it is an illustration");
  // The product reports orders and revenue per campaign, never ad spend: no invented ROAS or spend figure.
  assert.match(campaigns, /class="camp-caption">Ilustrasi /, "TopCampaignsShowcase says it is an illustration");
  const campaignCopy = campaigns.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(campaignCopy, /\bROAS\s*\d|\b\d+(?:[.,]\d+)?x\b|\bad spend\b/i, "no ROAS or spend figure the product cannot report");
  // White gallery: no wireframe connector lines left in the homepage diagrams.
  assert.doesNotMatch(geo + bento + band, /fork-line|map-stem|hub-rails|class="rail/, "layered UI cards, not boxes joined by lines");
  assert.ok(band.includes('class="signal-logo"'), "the animated logo stays");

  // The 8 keys the simulation shows are exactly the keys the store hashes and sends.
  const shown = JSON.parse((band.match(/const MATCH_KEYS = (\[[^\]]*\])/)?.[1] ?? "[]").replaceAll("'", '"')) as string[];
  const { buildMetaAdvancedMatching } = await import("../lib/meta-identity.ts");
  const sent = await buildMetaAdvancedMatching({ customer_name: "Rina Lestari", customer_phone: "081234567890", city: "Bandung", province: "Jawa Barat", postal_code: "40135", country: "id", external_id: "v1" });
  assert.deepEqual(shown.sort(), Object.keys(sent).filter((key) => key !== "client_user_agent").sort());
  assert.equal(shown.length, 8);

  // Rendered copy across the site: no stiff "pratinjau", no sloppy "angkanya dobel", no promise of a
  // ROAS number, no competitor/tracker/infra brand, no server signal claimed for TikTok.
  const pages = readdirSync("src/pages/platform/site").filter((name) => name.endsWith(".astro")).map((name) => `src/pages/platform/site/${name}`);
  const components = readdirSync("src/platform/site").filter((name) => name.endsWith(".astro")).map((name) => `src/platform/site/${name}`);
  const markupOf = (path: string) => readFileSync(path, "utf8").split("---").slice(2).join("---").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ");
  const strings = [...readFileSync("src/platform/site/content.ts", "utf8").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const bandData = [band, strip, geo, bento, compare, campaigns].flatMap((source) => [...source.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]));
  const copy = [...strings, ...bandData, ...[...pages, ...components].map(markupOf), readFileSync("src/platform/state-pages.ts", "utf8")].join("\n");
  assert.doesNotMatch(copy, /pratinjau/i);
  // Professional practitioner Indonesian (writer skill): no slang, no Malay that models leak in.
  assert.doesNotMatch(copy, /\b(suapi|disuapi|nyelonong|boncos|ngebut|gantung|ngoding|rakit|percuma|kerana|tetapan|laman|senarai|ianya)\b/i, "no slang or Malayisms");
  assert.doesNotMatch(copy, /angkanya dobel/i, "accurate ad terminology: konversi ganda, never angkanya dobel");
  assert.doesNotMatch(copy, /\b(scalev|orderonline|berdu|wetracked)\b/i, "head-to-head compares capabilities without naming rival brands");
  assert.doesNotMatch(copy, /\bROAS (naik|meningkat|dijamin)\s*\d|\bdijamin\b|\d+\s*%\s*lebih (untung|tinggi)/i, "no promised result");
  assert.doesNotMatch(copy, /Cloudflare|\bAstro\b|Durable Object|AdsBookCMS/);
  assert.doesNotMatch(copy, /\b[a-z0-9-]+\.(io|co)\b/i, "no other product's domain");
  // TikTok Pixel + Events API is real code since tracking chapter 11 Phase 1
  // (src/lib/tiktok-events.ts, tiktok-outbox.ts): the copy now states all
  // three server legs, each by the API that actually carries it.
  assert.match(copy, /Conversions API/, "Meta's server leg is named");
  assert.match(copy, /offline conversion|konversi offline/i, "Google's server leg is named");
  assert.match(copy, /TikTok[^.]{0,80}Events API|Events API[^.]{0,80}TikTok/, "TikTok's server leg is named");
  assert.doesNotMatch(copy, /TikTok[^.]{0,40}(Conversions API|konversi offline|offline conversion)/, "each platform keeps its own API name");
  assert.doesNotMatch(copy, /TikTok[^.]{0,30}(hanya|cuma) (lewat )?UTM/i, "no stale UTM-only claim for TikTok");
  assert.match(readFileSync("src/layouts/BaseLayout.astro", "utf8"), /Mode Review Pemilik/);
});

test("one clean header everywhere: the inner pages carry the home's header, no extra action, no rule under it", () => {
  const header = readFileSync("src/platform/site/SiteHeader.astro", "utf8");
  assert.doesNotMatch(header, /sh-try|SIGNUP_LABEL_SHORT/, "no second signup action in the header");
  const css = header.slice(header.indexOf("<style>"));
  assert.doesNotMatch(css, /\.sh-page\s*\{[^}]*border-bottom/, "no rule under the inner-page header");
  assert.match(css, /\.sh-hero, \.sh-page \{/, "both variants share one padding");
  const head = readFileSync("src/platform/site/PageHead.astro", "utf8");
  assert.match(head, /eyebrow\?: string/);
  assert.match(head, /mask-image/, "the dot grid fades out instead of ending on a line");
});
