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
};

/**
 * Where a value came from: the tenant's own store, or nowhere (T-45). There is
 * no Worker env fallback — a platform pixel id or CAPI token would put every
 * tenant's buyers into one ad account.
 */
export type AdsConfigSource = 'database' | 'none';

export async function getStoreAdsConfig(locals?: App.Locals): Promise<StoreAdsConfig> {
  // ADR-041: a store in Preview Mode or past its grace sends no ad signal from
  // a public request. The owner's admin still reads its own settings.
  if (locals?.billing?.adSignalsPaused && !locals.admin) return getStoreAdsConfig(undefined);
  let dbPixelId = '';
  let dbCapiToken = '';
  let dbGoogleId = '';
  let dbGoogleTagManagerId = '';
  let dbGoogleLabel = '';

  const database = tenantDatabase(locals);
  if (database && typeof database === 'object' && 'prepare' in database) {
    try {
      const row = (await database
        .prepare(
          `
        SELECT meta_pixel_id, meta_capi_token, google_tag_manager_id, google_ads_conversion_id, google_ads_conversion_label
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
      } | null;

      if (row) {
        dbPixelId = row.meta_pixel_id ?? '';
        // ADR-040: the token is stored sealed; unreadable reads as not set.
        dbCapiToken = (await openCredential(database, 'meta_capi_token', row.meta_capi_token)) ?? '';
        dbGoogleTagManagerId = row.google_tag_manager_id ?? '';
        dbGoogleId = row.google_ads_conversion_id ?? '';
        dbGoogleLabel = row.google_ads_conversion_label ?? '';
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
  };
}
