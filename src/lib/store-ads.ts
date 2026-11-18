// Extension-qualified like every other module here: Vite resolves either form,
// but `node --experimental-strip-types` does not, and the bare specifier is why
// this module could not be unit-tested at all (audit 2026-08-23 §2.6).
import { openCredential } from './credential-crypto.ts';
import { tenantDatabase } from "./tenant-database.ts";

export const GOOGLE_ADS_CONVERSION_ID_PATTERN = /^AW-\d{5,20}$/;
export const GOOGLE_ADS_CONVERSION_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The conversion destination is an atomic public configuration. A half-filled
 * or malformed pair must disable the direct Google Ads tag, not emit a broken
 * `send_to` value into the storefront.
 */
export function hasValidGoogleAdsConversion(
  conversionId: string,
  conversionLabel: string,
): boolean {
  return GOOGLE_ADS_CONVERSION_ID_PATTERN.test(conversionId)
    && GOOGLE_ADS_CONVERSION_LABEL_PATTERN.test(conversionLabel);
}

/** TikTok pixel code, as Events Manager shows it (tracking chapter 11 §2.4). */
export const TIKTOK_PIXEL_ID_PATTERN = /^[A-Z0-9]{10,32}$/;
/** A Test Events code from TikTok Events Manager: events carrying it are not billable conversions. */
export const TIKTOK_TEST_CODE_PATTERN = /^TEST[A-Za-z0-9_-]{2,32}$/;
export const TIKTOK_COD_TRIGGERS = ['order_created', 'delivered'] as const;
export type TikTokCodTrigger = (typeof TIKTOK_COD_TRIGGERS)[number];

export function normalizeTikTokCodTrigger(value: unknown): TikTokCodTrigger {
  return value === 'delivered' ? 'delivered' : 'order_created';
}

export type StoreAdsConfig = {
  metaPixelId: string;
  metaCapiToken: string;
  googleTagManagerId: string;
  googleAdsConversionId: string;
  googleAdsConversionLabel: string;
  metaPixelSource: AdsConfigSource;
  metaCapiSource: AdsConfigSource;
  googleTagManagerSource: AdsConfigSource;
  googleAdsConversionSource: AdsConfigSource;
  /** Empty unless it matches `TIKTOK_PIXEL_ID_PATTERN`: a malformed id renders no pixel. */
  tiktokPixelId: string;
  tiktokAccessToken: string;
  tiktokTestEventCode: string;
  tiktokCodTrigger: TikTokCodTrigger;
};

/**
 * Where a value came from: the tenant's own store, or nowhere (T-45). There is
 * no Worker env fallback — a platform pixel id or CAPI token would put every
 * tenant's buyers into one ad account.
 */
export type AdsConfigSource = 'database' | 'none';

export async function getStoreAdsConfig(locals?: App.Locals): Promise<StoreAdsConfig> {
  // ADR-041: a store in Preview Mode or past its grace sends no ad signal, from
  // any request (an admin confirming an old order's payment included). Every
  // caller of this function emits signals; the admin settings read their own rows.
  if (locals?.billing?.adSignalsPaused) return getStoreAdsConfig(undefined);
  let dbPixelId = '';
  let dbCapiToken = '';
  let dbGoogleId = '';
  let dbGoogleTagManagerId = '';
  let dbGoogleLabel = '';
  let dbTikTokPixelId = '';
  let dbTikTokToken = '';
  let dbTikTokTestCode = '';
  let dbTikTokTrigger: TikTokCodTrigger = 'order_created';

  const database = tenantDatabase(locals);
  if (database && typeof database === 'object' && 'prepare' in database) {
    try {
      const row = (await database
        .prepare(
          `
        SELECT meta_pixel_id, meta_capi_token, google_tag_manager_id, google_ads_conversion_id, google_ads_conversion_label,
               tiktok_pixel_id, tiktok_access_token, tiktok_test_event_code, tiktok_cod_trigger
        FROM stores
        ORDER BY id
        LIMIT 1
      `,
        )
        .first()) as {
        meta_pixel_id?: string | null;
        meta_capi_token?: string | null;
        google_tag_manager_id?: string | null;
        google_ads_conversion_id?: string | null;
        google_ads_conversion_label?: string | null;
        tiktok_pixel_id?: string | null;
        tiktok_access_token?: string | null;
        tiktok_test_event_code?: string | null;
        tiktok_cod_trigger?: string | null;
      } | null;

      if (row) {
        dbPixelId = row.meta_pixel_id ?? '';
        // ADR-040: the token is stored sealed; unreadable reads as not set.
        dbCapiToken = (await openCredential(database, 'meta_capi_token', row.meta_capi_token)) ?? '';
        dbGoogleTagManagerId = row.google_tag_manager_id ?? '';
        dbGoogleId = row.google_ads_conversion_id ?? '';
        dbGoogleLabel = row.google_ads_conversion_label ?? '';
        const tiktokPixelId = String(row.tiktok_pixel_id ?? '').trim();
        dbTikTokPixelId = TIKTOK_PIXEL_ID_PATTERN.test(tiktokPixelId) ? tiktokPixelId : '';
        dbTikTokToken = (await openCredential(database, 'tiktok_access_token', row.tiktok_access_token)) ?? '';
        const testCode = String(row.tiktok_test_event_code ?? '').trim();
        dbTikTokTestCode = TIKTOK_TEST_CODE_PATTERN.test(testCode) ? testCode : '';
        dbTikTokTrigger = normalizeTikTokCodTrigger(row.tiktok_cod_trigger);
      }
    } catch {
      // An unreadable row is an unconfigured store: nothing is sent.
    }
  }

  const hasGoogleAdsConversion = hasValidGoogleAdsConversion(dbGoogleId, dbGoogleLabel);
  const source = (value: string): AdsConfigSource => (value ? 'database' : 'none');

  return {
    metaPixelId: dbPixelId,
    metaCapiToken: dbCapiToken,
    googleTagManagerId: dbGoogleTagManagerId,
    googleAdsConversionId: hasGoogleAdsConversion ? dbGoogleId : '',
    googleAdsConversionLabel: hasGoogleAdsConversion ? dbGoogleLabel : '',
    metaPixelSource: source(dbPixelId),
    metaCapiSource: source(dbCapiToken),
    googleTagManagerSource: source(dbGoogleTagManagerId),
    googleAdsConversionSource: hasGoogleAdsConversion ? 'database' : 'none',
    tiktokPixelId: dbTikTokPixelId,
    tiktokAccessToken: dbTikTokToken,
    tiktokTestEventCode: dbTikTokTestCode,
    tiktokCodTrigger: dbTikTokTrigger,
  };
}
