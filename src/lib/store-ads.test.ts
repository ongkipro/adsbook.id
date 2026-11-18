import { bindTestCredentialsIn } from "../platform/testing/credentials.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  getStoreAdsConfig,
  hasValidGoogleAdsConversion,
} from "./store-ads.ts";
import { sendMetaCapiEvent } from "./meta-capi.ts";

/**
 * Audit 2026-08-23 §2.6: this module resolves the pixel id, CAPI token and
 * Google identifiers every tracking path depends on, and a silent
 * misresolution disables tracking store-wide without failing loudly.
 *
 * T-45: the tenant's own row is the only source. A Worker env value would put
 * every tenant's buyers into one ad account, so each test sets every former
 * env name (in `runtimeEnv` and `process.env`) and asserts none is used.
 */

type StoreRow = Record<string, string | null> | null;

function storeDatabase__raw(row: StoreRow, options: { throws?: boolean } = {}) {
  return {
    prepare() {
      return {
        async first() {
          if (options.throws) throw new Error("no such table: stores");
          return row;
        },
      };
    },
  } as unknown as D1Database;
}

const PLATFORM_ENV = {
  NEXT_PUBLIC_FB_PIXEL_ID: "999999999999991",
  PUBLIC_FB_PIXEL_ID: "999999999999992",
  FB_PIXEL_ID: "999999999999993",
  META_PIXEL_ID: "999999999999994",
  META_CAPI_ACCESS_TOKEN: "env-capi-token",
  META_CAPI_TOKEN: "env-capi-token-2",
  PUBLIC_GTM_ID: "GTM-ENVONLY",
  GTM_ID: "GTM-ENVONLY2",
  GOOGLE_ADS_CONVERSION_ID: "AW-999999999",
  GOOGLE_ADS_CONVERSION_LABEL: "env-label",
};

function withPlatformEnv(context: { after: (fn: () => void) => void }) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(PLATFORM_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  context.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const CONFIGURED_ROW = {
  meta_pixel_id: "111111111111111",
  meta_capi_token: "db-capi-token",
  google_tag_manager_id: "GTM-DBSTORE",
  google_ads_conversion_id: "AW-111111111",
  google_ads_conversion_label: "db-label",
};

/** A store that has not set TikTok up: every field empty, the default COD trigger. */
const NO_TIKTOK = {
  tiktokPixelId: "",
  tiktokAccessToken: "",
  tiktokTestEventCode: "",
  tiktokCodTrigger: "order_created",
};

const UNCONFIGURED = {
  metaPixelId: "",
  metaCapiToken: "",
  googleTagManagerId: "",
  googleAdsConversionId: "",
  googleAdsConversionLabel: "",
  metaPixelSource: "none",
  metaCapiSource: "none",
  googleTagManagerSource: "none",
  googleAdsConversionSource: "none",
  ...NO_TIKTOK,
};

test("a configured tenant resolves exactly its own row", async (context) => {
  withPlatformEnv(context);
  const config = await getStoreAdsConfig({
    tenantDb: storeDatabase(CONFIGURED_ROW), runtimeEnv: PLATFORM_ENV,
  } as never);

  assert.deepEqual(config, {
    metaPixelId: "111111111111111",
    metaCapiToken: "db-capi-token",
    googleTagManagerId: "GTM-DBSTORE",
    googleAdsConversionId: "AW-111111111",
    googleAdsConversionLabel: "db-label",
    metaPixelSource: "database",
    metaCapiSource: "database",
    googleTagManagerSource: "database",
    googleAdsConversionSource: "database",
    ...NO_TIKTOK,
  });
});

test("a tenant without settings is unconfigured even with every platform env value set (T-45)", async (context) => {
  withPlatformEnv(context);
  for (const row of [null, {}, { meta_pixel_id: "", meta_capi_token: null }] as StoreRow[]) {
    const config = await getStoreAdsConfig({ tenantDb: storeDatabase(row), runtimeEnv: PLATFORM_ENV } as never);
    assert.deepEqual(config, UNCONFIGURED, JSON.stringify(row));
  }
});

test("a blank field stays blank: no field is filled from the environment", async (context) => {
  withPlatformEnv(context);
  const config = await getStoreAdsConfig({
    tenantDb: storeDatabase({ ...CONFIGURED_ROW, meta_capi_token: "", google_tag_manager_id: null }),
    runtimeEnv: PLATFORM_ENV,
  } as never);
  assert.equal(config.metaPixelId, "111111111111111");
  assert.equal(config.metaCapiToken, "");
  assert.equal(config.metaCapiSource, "none");
  assert.equal(config.googleTagManagerId, "");
});

test("a failed store read is an unconfigured tenant, not an env fallback", async (context) => {
  withPlatformEnv(context);
  const config = await getStoreAdsConfig({
    tenantDb: storeDatabase(null, { throws: true }), runtimeEnv: PLATFORM_ENV,
  } as never);
  assert.deepEqual(config, UNCONFIGURED);
});

test("Google Ads direct conversion requires a valid complete destination from the row", async (context) => {
  withPlatformEnv(context);
  assert.equal(hasValidGoogleAdsConversion("AW-111111111", "valid_label-1"), true);
  assert.equal(hasValidGoogleAdsConversion("AW-111111111", ""), false);
  assert.equal(hasValidGoogleAdsConversion("G-111111111", "valid_label-1"), false);
  assert.equal(hasValidGoogleAdsConversion("AW-111111111", "not valid"), false);

  const halfSet = await getStoreAdsConfig({
    tenantDb: storeDatabase({ ...CONFIGURED_ROW, google_ads_conversion_label: null }), runtimeEnv: PLATFORM_ENV,
  } as never);
  assert.equal(halfSet.googleAdsConversionId, "");
  assert.equal(halfSet.googleAdsConversionLabel, "");
  assert.equal(halfSet.googleAdsConversionSource, "none");
});

/**
 * A-226, decided in T-45: a tenant with a pixel id and no CAPI token keeps its
 * browser pixel (the seller's ads still see PageView/Purchase from the browser
 * leg), and the server leg sends nothing — `meta-not-configured`, which the
 * Purchase path already records and the health panel reports as Meta CAPI not
 * configured. It never borrows a platform token.
 */
test("A-226: pixel without a CAPI token keeps the browser pixel and sends no server event", async (context) => {
  withPlatformEnv(context);
  const config = await getStoreAdsConfig({
    tenantDb: storeDatabase({ meta_pixel_id: "111111111111111", meta_capi_token: null }),
    runtimeEnv: PLATFORM_ENV,
  } as never);
  assert.equal(config.metaPixelId, "111111111111111", "the browser pixel still loads");
  assert.equal(config.metaCapiToken, "");

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("{}");
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const result = await sendMetaCapiEvent(
    "Purchase",
    "INV-10001",
    "https://toko-a.adsbook.my.id/thanks",
    { clientIp: "203.0.113.1", userAgent: "test" },
    { orderNumber: "INV-10001", value: 100000, currency: "IDR" },
    config.metaPixelId,
    config.metaCapiToken,
  );
  assert.deepEqual(result, { success: false, reason: "meta-not-configured" });
  assert.deepEqual(calls, [], "no request to Meta without the tenant's own token");
});

// T-48: the fixture handle carries the test credential key, like a real tenant handle.
function storeDatabase(...args: Parameters<typeof storeDatabase__raw>): ReturnType<typeof storeDatabase__raw> {
  return bindTestCredentialsIn(storeDatabase__raw(...args));
}

test("ADR-041: a store that is not live sends no ad signal from any request; grace keeps campaigns running", async () => {
  const row = { meta_pixel_id: "100000000000001", meta_capi_token: null, google_tag_manager_id: "GTM-ABCD12", google_ads_conversion_id: null, google_ads_conversion_label: null };
  const tenantDb = storeDatabase__raw(row);
  const paused = { tenantDb, billing: { state: "preview" as const, adSignalsPaused: true } } as unknown as App.Locals;
  const publicConfig = await getStoreAdsConfig(paused);
  assert.equal(publicConfig.metaPixelId, "");
  assert.equal(publicConfig.googleTagManagerId, "");
  // R4 review: an admin request (confirming an old order's payment) sends nothing either.
  const adminConfig = await getStoreAdsConfig({ ...paused, admin: { username: "o", role: "owner", mustChangePassword: false } } as unknown as App.Locals);
  assert.equal(adminConfig.metaPixelId, "");
  const live = await getStoreAdsConfig({ tenantDb, billing: { state: "grace", adSignalsPaused: false } } as unknown as App.Locals);
  assert.equal(live.metaPixelId, "100000000000001", "grace keeps campaigns running");
});
