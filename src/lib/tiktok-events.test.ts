import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { adChannelFromClickIds, adChannelSql } from "./ad-channel.ts";
import { mergeClickIds, parseClickIdsFromUrl, readTikTokBrowserIds, serializeClickIds, CLICK_ID_COOKIE } from "./click-ids.ts";
import { buildMetaAdvancedMatching } from "./meta-identity.ts";
import { tiktokFunnelProperties } from "./tiktok-browser.ts";
import {
  TIKTOK_EVENTS_ENDPOINT,
  buildTikTokUserData,
  decideTikTokRetry,
  sendTikTokEvents,
  tikTokProperties,
  toTikTokPhone,
  validateTikTokFunnelPayload,
} from "./tiktok-events.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const MINUTE = 60_000;

// ---- Identity: the one character Meta and TikTok disagree on ----

test("TikTok hashes the phone as +62… (E.164 with the plus), never Meta's bare 62…", async () => {
  const user = await buildTikTokUserData({ phone: "0812-3456-7890" });
  assert.equal(toTikTokPhone("0812-3456-7890"), "+6281234567890");
  assert.equal(user.phone, sha("+6281234567890"));
  assert.notEqual(user.phone, sha("6281234567890"), "Meta's digits-only form silently matches no one on TikTok");
  // The same number, Meta's way: the two legs differ by exactly the plus.
  const meta = await buildMetaAdvancedMatching({ customer_phone: "0812-3456-7890" });
  assert.equal(meta.ph, sha("6281234567890"));
  for (const typed of ["+62 812 3456 7890", "6281234567890", "0062 812-3456-7890", "81234567890"]) {
    assert.equal((await buildTikTokUserData({ phone: typed })).phone, sha("+6281234567890"), typed);
  }
});

test("email and external_id are trimmed, lower-cased and hashed; click ids, ip and user agent travel raw", async () => {
  const user = await buildTikTokUserData({
    email: "  Siti.Rahayu@Example.COM ",
    externalId: "0123456789ABCDEF0123456789ABCDEF",
    ttclid: "E.C.P.abc_123",
    ttp: "AbCdEfGhIjKlMnOpQrStUvWxYz0",
    ip: "203.0.113.10",
    userAgent: "Mozilla/5.0 (Linux; Android 14)",
    locale: "id-ID",
  });
  assert.deepEqual(user, {
    ttclid: "E.C.P.abc_123",
    ttp: "AbCdEfGhIjKlMnOpQrStUvWxYz0",
    email: sha("siti.rahayu@example.com"),
    external_id: sha("0123456789abcdef0123456789abcdef"),
    ip: "203.0.113.10",
    user_agent: "Mozilla/5.0 (Linux; Android 14)",
    locale: "id-ID",
  });
});

test("a key that is empty, malformed, or a server's user agent is left out, not sent blank", async () => {
  assert.deepEqual(
    await buildTikTokUserData({ phone: "12", email: "bukan-email", externalId: "visitor", ttclid: "<x>", ip: "unknown", userAgent: "undici" }),
    {},
  );
  for (const agent of ["node", "curl/8.4.0", "undici", "python-requests/2.31"]) {
    assert.equal((await buildTikTokUserData({ userAgent: agent })).user_agent, undefined, agent);
  }
});

// ---- The retry ladder ----

test("code 0 is delivered; a rate limit waits 15 minutes; a client error is terminal at once", () => {
  assert.deepEqual(decideTikTokRetry({ httpStatus: 200, code: 0 }, 0, 8), { status: "sent", delayMs: 0 });
  assert.deepEqual(decideTikTokRetry({ httpStatus: 429 }, 0, 8), { status: "pending", delayMs: 15 * MINUTE });
  assert.deepEqual(decideTikTokRetry({ httpStatus: 200, code: 40100 }, 2, 8), { status: "pending", delayMs: 15 * MINUTE });
  for (const code of [40001, 40002, 40105, 40099]) {
    assert.deepEqual(decideTikTokRetry({ httpStatus: 200, code }, 0, 8), { status: "failed", delayMs: 0 }, `code ${code}`);
  }
  assert.equal(decideTikTokRetry({ httpStatus: 401 }, 0, 8).status, "failed", "HTTP 4xx without a code");
});

test("a server error or network failure doubles from two minutes, caps at an hour, and stops at max_attempts", () => {
  assert.deepEqual(decideTikTokRetry({ httpStatus: 200, code: 50000 }, 0, 8), { status: "pending", delayMs: 2 * MINUTE });
  assert.deepEqual(decideTikTokRetry({ httpStatus: 503 }, 1, 8), { status: "pending", delayMs: 4 * MINUTE });
  assert.deepEqual(decideTikTokRetry({ httpStatus: 0, message: "timeout" }, 2, 8), { status: "pending", delayMs: 8 * MINUTE });
  assert.equal(decideTikTokRetry({ httpStatus: 503 }, 20, 50).delayMs, 60 * MINUTE);
  assert.equal(decideTikTokRetry({ httpStatus: 503 }, 7, 8).status, "failed");
  assert.equal(decideTikTokRetry({ httpStatus: 200 }, 0, 8).status, "pending", "a 200 without code 0 is not a delivery");
  // Review finding 4: a gateway 5xx carrying a 4xxxx body is transient, not terminal.
  assert.deepEqual(decideTikTokRetry({ httpStatus: 503, code: 40002 }, 0, 8), { status: "pending", delayMs: 2 * MINUTE });
  assert.deepEqual(decideTikTokRetry({ httpStatus: 502, code: 40001 }, 1, 8), { status: "pending", delayMs: 4 * MINUTE });
});

// ---- The request ----

test("the Events API call: v1.3 track endpoint, Access-Token header, web source, test code only when given", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ code: 0, message: "OK" });
  }) as unknown as typeof fetch;
  const event = {
    event: "CompletePayment" as const,
    event_time: 1_763_450_000,
    event_id: "INV-10042",
    user: { ttclid: "E.C.P.1" },
    properties: tikTokProperties({ value: 149_000, orderNumber: "INV-10042", contents: [{ content_id: "10012", price: 149_000, quantity: 1 }] }),
    page: { url: "https://toko.adsbook.my.id/thanks" },
  };
  assert.deepEqual(await sendTikTokEvents("C4ABCDEFGHIJ1234", "tok-secret", [event], undefined, fetchImpl), { httpStatus: 200, code: 0, message: "OK" });
  assert.equal(calls[0].url, TIKTOK_EVENTS_ENDPOINT);
  assert.equal(TIKTOK_EVENTS_ENDPOINT, "https://business-api.tiktok.com/open_api/v1.3/event/track/");
  assert.equal((calls[0].init.headers as Record<string, string>)["Access-Token"], "tok-secret");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, { event_source: "web", event_source_id: "C4ABCDEFGHIJ1234", data: [event] });
  assert.equal(body.data[0].properties.currency, "IDR");
  assert.equal(body.data[0].properties.order_id, "INV-10042");
  await sendTikTokEvents("C4ABCDEFGHIJ1234", "tok-secret", [event], "TEST12345", fetchImpl);
  assert.equal(JSON.parse(String(calls[1].init.body)).test_event_code, "TEST12345");
  const failed = await sendTikTokEvents("C4ABCDEFGHIJ1234", "t", [event], undefined, (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch);
  assert.deepEqual(failed, { httpStatus: 0, message: "socket hang up" });
});

test("/api/tiktok-event's boundary: funnel events only, a bounded id, same-origin page, clean contents", () => {
  const origin = "https://toko.adsbook.my.id/api/tiktok-event";
  const ok = validateTikTokFunnelPayload({
    event: "AddToCart",
    event_id: "addtocart_serum_1763450000000_ab12cd",
    url: "https://toko.adsbook.my.id/produk/serum?ttclid=E1",
    properties: {
      value: 149000,
      contents: [
        { content_id: "10012", content_name: "Serum", price: 149000, quantity: 1 },
        { content_id: "<script>", quantity: 1 },
      ],
    },
    phone: "081234567890",
  }, origin);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.contents.length, 1, "a malformed content id is dropped");
    assert.equal(ok.value.url, "https://toko.adsbook.my.id/produk/serum?ttclid=E1");
  }
  assert.equal(validateTikTokFunnelPayload({ event: "CompletePayment", event_id: "INV-10042" }, origin).ok, false, "never a browser-claimed conversion");
  assert.equal(validateTikTokFunnelPayload({ event: "ViewContent", event_id: "x" }, origin).ok, false);
  const foreign = validateTikTokFunnelPayload({ event: "ViewContent", event_id: "vc_1763450000000_ab", url: "https://lain.example/x", properties: { value: -5 } }, origin);
  assert.ok(foreign.ok && foreign.value.url === "https://toko.adsbook.my.id/" && foreign.value.value === 0);
});

test("the browser helper builds one product at quantity one in IDR", () => {
  assert.deepEqual(tiktokFunnelProperties({ contentId: "10012", contentName: "Serum", value: 149000 }), {
    contents: [{ content_id: "10012", content_name: "Serum", price: 149000, quantity: 1 }],
    content_type: "product",
    value: 149000,
    currency: "IDR",
  });
  assert.equal(tiktokFunnelProperties({}).contents, undefined);
});

// ---- First-party ttclid: kept 90 days, attributed without a UTM ----

test("a fresh ttclid replaces an older click, and a later WhatsApp follow-up keeps it", () => {
  const monday = mergeClickIds({ gclid: "Cj0old", utm_source: "google" }, parseClickIdsFromUrl(new URL("https://toko.test/?ttclid=E_C_P_123")));
  assert.deepEqual(monday, { ttclid: "E_C_P_123" }, "last touch wins, a stale Google click does not linger");
  const wednesday = mergeClickIds(monday, parseClickIdsFromUrl(new URL("https://toko.test/?utm_source=whatsapp&utm_medium=cs")));
  assert.equal(wednesday.ttclid, "E_C_P_123", "the CS follow-up link does not erase the paid click");
  assert.equal(wednesday.utm_source, "whatsapp");
});

test("an order holding only a ttclid reads as TikTok in JS and in SQLite alike", () => {
  const stored = serializeClickIds({ ttclid: "E_C_P_123" });
  assert.equal(adChannelFromClickIds(stored), "tiktok");
  const sqlite = new DatabaseSync(":memory:");
  const row = sqlite.prepare(`SELECT ${adChannelSql("?1")} AS channel`).get(stored) as { channel: string };
  assert.equal(row.channel, "tiktok");
});

test("the server reads _ttp and the stored ttclid from the request's own cookies", () => {
  const request = new Request("https://toko.test/api/tiktok-event", {
    headers: { cookie: `_ttp=AbCdEfGhIjKlMnOpQrStUvWxYz0; ${CLICK_ID_COOKIE}=${encodeURIComponent(serializeClickIds({ ttclid: "E_C_P_9" }))}` },
  });
  assert.deepEqual(readTikTokBrowserIds(request), { ttp: "AbCdEfGhIjKlMnOpQrStUvWxYz0", ttclid: "E_C_P_9" });
});

// ---- The storefront surface, read from source ----

test("CSP allows TikTok's one origin for script and beacon only, and the pixel renders only for a valid id", async () => {
  const { readFileSync } = await import("node:fs");
  const middleware = readFileSync("src/middleware.ts", "utf8");
  const csp = middleware.slice(middleware.indexOf("export const STOREFRONT_CSP"), middleware.indexOf('].join("; ");'));
  const directive = (name: string) => csp.split("\n").find((line) => line.includes(`"${name} `)) ?? "";
  assert.match(directive("script-src"), /https:\/\/analytics\.tiktok\.com/);
  assert.match(directive("connect-src"), /https:\/\/analytics\.tiktok\.com/);
  assert.doesNotMatch(directive("frame-src"), /tiktok/, "no frame permission it does not need");
  assert.doesNotMatch(csp, /\*\.tiktok/, "one origin, never a wildcard");
  const base = readFileSync("src/components/storefront/tracking/TikTokPixelBase.astro", "utf8");
  assert.match(base, /TIKTOK_PIXEL_ID_PATTERN\.test/, "a store without a valid pixel ships zero TikTok bytes");
  assert.match(base, /setTimeout\(loadPixel, 2500\)/, "events.js is deferred, never render-blocking");
  assert.match(base, /SERVER_EVENTS = new Set\(\['ViewContent', 'AddToCart', 'InitiateCheckout'\]\)/, "CompletePayment never posts from the browser");
  assert.match(readFileSync("src/layouts/BaseLayout.astro", "utf8"), /<TikTokPixelBase pixelId=\{adsConfig\.tiktokPixelId\} \/>/);
  const thanks = readFileSync("src/components/storefront/tracking/MetaThanksTracker.astro", "utf8");
  assert.match(thanks, /tiktokEligible = statusData\.tiktok_complete_payment === true/, "/thanks follows the server's rule, the COD trigger included");
});

test("CSP allows Cloudflare Web Analytics' two exact origins, script and report, and no wildcard", async () => {
  const { readFileSync } = await import("node:fs");
  const middleware = readFileSync("src/middleware.ts", "utf8");
  const csp = middleware.slice(middleware.indexOf("export const STOREFRONT_CSP"), middleware.indexOf('].join("; ");'));
  const directive = (name: string) => csp.split("\n").find((line) => line.includes(`"${name} `)) ?? "";
  assert.match(directive("script-src"), / https:\/\/static\.cloudflareinsights\.com[ "]/);
  assert.match(directive("connect-src"), / https:\/\/cloudflareinsights\.com[ "]/);
  assert.doesNotMatch(csp, /\*\.cloudflareinsights/);
});

test("CSP lets gtag load Google Ads' remarketing script from its one exact host; the admin policy gains nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const middleware = readFileSync("src/middleware.ts", "utf8");
  const csp = middleware.slice(middleware.indexOf("export const STOREFRONT_CSP"), middleware.indexOf('].join("; ");'));
  const directive = (name: string) => csp.split("\n").find((line) => line.includes(`"${name} `)) ?? "";
  const scriptSrc = directive("script-src");
  // gtag.js injects googleads.g.doubleclick.net/pagead/viewthroughconversion/<id>/ as a script (2026-11-24).
  assert.match(scriptSrc, / https:\/\/googleads\.g\.doubleclick\.net[ "]/);
  assert.doesNotMatch(scriptSrc, /\*\.(g\.)?doubleclick\.net/, "one exact host for scripts, never a wildcard");
  assert.doesNotMatch(scriptSrc, /https:\/\/(?!googleads\.g\.)[a-z.]*doubleclick\.net/, "no other doubleclick host may run scripts");
  // The admin and platform policies carry no script or connect allowance at all.
  const admin = /export const ADMIN_CSP = "([^"]+)"/.exec(middleware)?.[1];
  assert.equal(admin, "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  const platform = middleware.slice(middleware.indexOf("function platformCsp("), middleware.indexOf("async function loadStoredEmbedAllowedOrigins"));
  assert.doesNotMatch(platform, /doubleclick|script-src|connect-src/);
});

