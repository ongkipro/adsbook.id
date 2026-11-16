import { CREDENTIAL_KEY_UNAVAILABLE_MESSAGE, CredentialKeyUnavailableError, openCredential, sealCredential } from '../../../lib/credential-crypto';
import type { APIRoute } from 'astro';
import { maskSecretValue } from '../../../lib/env';
import { sendMetaCapiEvent, verifyMetaPixelIdentity } from '../../../lib/meta-capi';
import { countRecoverableEvents, drainCapiOutbox, requeueRecoverableEvents } from '../../../lib/capi-outbox';
import {
  GOOGLE_ADS_CONVERSION_ID_PATTERN,
  GOOGLE_ADS_CONVERSION_LABEL_PATTERN,
} from '../../../lib/store-ads';
import {
  planGoogleAdsOfflineSave,
  readGoogleAdsOfflineConfig,
  openGoogleAdsOfflineSecrets,
  sealGoogleAdsOfflineSecrets,
  type GoogleAdsOfflineRow,
} from '../../../lib/google-ads-offline';
import { tenantDatabase } from '../../../lib/tenant-database.ts';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PIXEL_ID_PATTERN = /^\d{5,25}$/;
const GTM_ID_PATTERN = /^GTM-[A-Z0-9]{4,20}$/;
const META_TEST_CODE_PATTERN = /^TEST\d{3,20}$/;

type AdsConfigPayload = {
  action?: 'save-meta' | 'save-google' | 'save-google-offline' | 'test-capi' | 'requeue-capi';
  meta_pixel_id?: string;
  meta_capi_token?: string;
  meta_test_event_code?: string;
  google_ads_conversion_id?: string;
  google_tag_manager_id?: string;
  google_ads_conversion_label?: string;
  google_offline?: {
    clear?: boolean;
    customer_id?: string;
    conversion_action_id?: string;
    login_customer_id?: string;
    developer_token?: string;
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
  };
};

type AdsRow = GoogleAdsOfflineRow & {
  meta_pixel_id: string | null;
  meta_capi_token: string | null;
  google_tag_manager_id: string | null;
  google_ads_conversion_id: string | null;
  google_ads_conversion_label: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function getD1(locals: App.Locals) {
  const database = tenantDatabase(locals);
  return database && typeof database === 'object' ? database as D1Database : null;
}

function clean(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** The row with its secrets opened (ADR-040); a value that cannot be opened reads as not set. */
async function getAdsRow(database: D1Database) {
  const row = await readAdsRow(database);
  if (!row) return null;
  const opened = await openGoogleAdsOfflineSecrets(database, row);
  return { ...opened!, meta_capi_token: await openCredential(database, 'meta_capi_token', row.meta_capi_token) };
}

async function readAdsRow(database: D1Database) {
  return await database.prepare(`
    SELECT meta_pixel_id, meta_capi_token, google_tag_manager_id, google_ads_conversion_id, google_ads_conversion_label,
      google_ads_customer_id, google_ads_offline_conversion_action_id, google_ads_login_customer_id,
      google_ads_offline_start_at, google_ads_developer_token, google_ads_client_id, google_ads_client_secret,
      google_ads_refresh_token
    FROM stores
    ORDER BY id
    LIMIT 1
  `).first() as AdsRow | null;
}

/** The tenant's own saved values only (T-45): no env token is shown or used. */
function publicConfig(row: AdsRow) {
  const token = row.meta_capi_token ?? '';
  return {
    meta_pixel_id: row.meta_pixel_id ?? '',
    meta_capi_configured: Boolean(token),
    meta_capi_token_masked: maskSecretValue(token),
    google_tag_manager_id: row.google_tag_manager_id ?? '',
    google_ads_conversion_id: row.google_ads_conversion_id ?? '',
    google_ads_conversion_label: row.google_ads_conversion_label ?? '',
    // Secrets leave masked or as a flag only (AGENTS.md: never echo a credential).
    google_offline: {
      configured: readGoogleAdsOfflineConfig(row) !== null,
      customer_id: row.google_ads_customer_id ?? '',
      conversion_action_id: row.google_ads_offline_conversion_action_id ?? '',
      login_customer_id: row.google_ads_login_customer_id ?? '',
      start_at: row.google_ads_offline_start_at ?? '',
      developer_token_masked: maskSecretValue(row.google_ads_developer_token ?? ''),
      client_id_masked: maskSecretValue(row.google_ads_client_id ?? ''),
      client_secret_set: Boolean(row.google_ads_client_secret?.trim()),
      refresh_token_set: Boolean(row.google_ads_refresh_token?.trim()),
    },
  };
}

export const GET: APIRoute = async ({ locals }) => {
  const database = getD1(locals);
  if (!database) return json({ success: false, error: 'Database konfigurasi belum tersedia.' }, 503);

  try {
    const row = await getAdsRow(database);
    if (!row) return json({ success: false, error: 'Store belum tersedia.' }, 404);
    return json({
      success: true,
      data: {
        ...publicConfig(row),
        // Surfaced so the operator is told the outage is recoverable rather
        // than having to know to ask. Zero on a healthy store.
        capi_recoverable_events: await countRecoverableEvents(database).catch(() => 0),
      },
    });
  } catch (error) {
    console.error('ads-config-get', error);
    return json({ success: false, error: 'Gagal mengambil konfigurasi iklan & tracking.' }, 500);
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const database = getD1(locals);
  if (!database) return json({ success: false, error: 'Database konfigurasi belum tersedia.' }, 503);

  const body = await request.json().catch(() => null) as AdsConfigPayload | null;
  if (!body) return json({ success: false, error: 'Payload tidak valid.' }, 400);

  try {
    const current = await getAdsRow(database);
    if (!current) return json({ success: false, error: 'Store belum tersedia.' }, 404);

    const submittedPixelId = clean(body.meta_pixel_id, 25);
    const submittedToken = clean(body.meta_capi_token, 4096);
    const testEventCode = clean(body.meta_test_event_code, 24).toUpperCase();
    const storedToken = submittedToken || current.meta_capi_token || '';

    if (body.action === 'requeue-capi') {
      const pixelId = submittedPixelId || current.meta_pixel_id || '';
      if (!PIXEL_ID_PATTERN.test(pixelId) || !storedToken) {
        return json({ success: false, error: 'Simpan Pixel ID dan Access Token yang valid sebelum mengirim ulang.' }, 400);
      }
      // Proven live before anything is moved: requeueing against a token that
      // is still dead would re-terminate every row and spend the operator's
      // one recovery on nothing.
      const probe = await sendMetaCapiEvent(
        'PageView',
        `requeue_probe_${Date.now()}`,
        new URL(request.url).origin,
        {
          clientIp: request.headers.get('cf-connecting-ip') || '127.0.0.1',
          userAgent: request.headers.get('user-agent') || 'adsbook.id-CAPI-Tester/1.0',
        },
        {},
        pixelId,
        storedToken,
      ).catch(() => ({ success: false, reason: 'Koneksi ke Meta CAPI gagal.' }));
      if (!probe.success) {
        return json({ success: false, error: probe.reason || 'Meta menolak token saat ini; tidak ada event yang dikirim ulang.' }, 400);
      }
      const requeued = await requeueRecoverableEvents(database);
      const delivered = requeued ? await drainCapiOutbox(database, pixelId, storedToken) : 0;
      return json({
        success: true,
        message: requeued
          ? `${requeued} event dikirim ulang, ${delivered} sudah diterima Meta. Sisanya menunggu antrean.`
          : 'Tidak ada event gagal yang bisa dikirim ulang.',
        data: { requeued, delivered },
      });
    }

    if (body.action === 'test-capi') {
      const pixelId = submittedPixelId || current.meta_pixel_id || '';
      if (!PIXEL_ID_PATTERN.test(pixelId)) return json({ success: false, error: 'Meta Pixel ID hanya boleh berisi 5–25 digit.' }, 400);
      if (!storedToken) return json({ success: false, error: 'Meta CAPI Access Token belum dikonfigurasi.' }, 400);
      if (!META_TEST_CODE_PATTERN.test(testEventCode)) return json({ success: false, error: 'Meta Test Event Code harus berformat TEST diikuti 3–20 digit.' }, 400);

      const result = await sendMetaCapiEvent(
        'PageView',
        `settings_test_${Date.now()}`,
        new URL(request.url).origin,
        {
          clientIp: request.headers.get('cf-connecting-ip') || '127.0.0.1',
          userAgent: request.headers.get('user-agent') || 'adsbook.id-CAPI-Tester/1.0',
        },
        { contentName: 'adsbook.id Meta CAPI connection test' },
        pixelId,
        storedToken,
        testEventCode,
      ).catch(() => ({ success: false, reason: 'Koneksi ke Meta CAPI gagal.' }));

      return json(
        {
          success: result.success,
          message: result.success ? 'Test event diterima Meta Conversions API.' : result.reason || 'Test event ditolak Meta Conversions API.',
        },
        result.success ? 200 : 400,
      );
    }

    let identityWarning: string | undefined;
    if (body.action === 'save-meta') {
      if (submittedPixelId && !PIXEL_ID_PATTERN.test(submittedPixelId)) return json({ success: false, error: 'Meta Pixel ID hanya boleh berisi 5–25 digit.' }, 400);
      // A digit check cannot tell a pixel from a Business Manager ID, and
      // saving the wrong one kills the browser Pixel and the Conversions API
      // together, silently, until someone reads Graph API error codes. Ask Meta
      // what the ID actually is while the operator is still on the screen.
      if (submittedPixelId && submittedPixelId !== current.meta_pixel_id && storedToken) {
        const identity = await verifyMetaPixelIdentity(submittedPixelId, storedToken);
        if (identity.state === 'not-a-pixel') {
          return json(
            {
              success: false,
              error:
                `ID ${submittedPixelId} ada di Meta${identity.name ? ` dengan nama "${identity.name}"` : ''}, ` +
                'tetapi bukan Pixel/Dataset — kemungkinan ID Business Manager, Page, atau Ad Account. ' +
                'Ambil Dataset ID dari Events Manager → Data Sources → Settings.',
            },
            400,
          );
        }
        if (identity.state === 'unknown') {
          // Never block on an inconclusive answer: a permission gap or a
          // network blip must not stop an operator saving a correct ID.
          identityWarning =
            `ID tersimpan, tetapi belum dapat dipastikan sebagai Pixel/Dataset (${identity.reason}). ` +
            'Jalankan "Kirim test event" untuk memastikan.';
        }
      }
      await database.prepare(`
        UPDATE stores
        SET meta_pixel_id = ?,
            meta_capi_token = CASE WHEN ? = '' THEN meta_capi_token ELSE ? END
        WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)
      `).bind(submittedPixelId || null, submittedToken, submittedToken && await sealCredential(database, 'meta_capi_token', submittedToken)).run();
    } else if (body.action === 'save-google') {
      const googleTagManagerId = clean(body.google_tag_manager_id, 24).toUpperCase();
      const googleId = clean(body.google_ads_conversion_id, 24);
      const googleLabel = clean(body.google_ads_conversion_label, 100);
      if (Boolean(googleId) !== Boolean(googleLabel)) return json({ success: false, error: 'Conversion ID dan Label harus diisi berpasangan.' }, 400);
      if (googleTagManagerId && !GTM_ID_PATTERN.test(googleTagManagerId)) return json({ success: false, error: 'Google Tag Manager ID harus berformat GTM-XXXXXXX.' }, 400);
      if (googleId && !GOOGLE_ADS_CONVERSION_ID_PATTERN.test(googleId)) return json({ success: false, error: 'Google Ads Conversion ID harus berformat AW-XXXXXXXXX.' }, 400);
      if (googleLabel && !GOOGLE_ADS_CONVERSION_LABEL_PATTERN.test(googleLabel)) return json({ success: false, error: 'Google Ads Conversion Label tidak valid.' }, 400);
      await database.prepare(`
        UPDATE stores
        SET google_tag_manager_id = ?, google_ads_conversion_id = ?, google_ads_conversion_label = ?
        WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)
      `).bind(googleTagManagerId || null, googleId || null, googleLabel || null).run();
    } else if (body.action === 'save-google-offline') {
      const offline = body.google_offline ?? {};
      const plan = planGoogleAdsOfflineSave(
        {
          clear: offline.clear,
          customerId: offline.customer_id,
          conversionActionId: offline.conversion_action_id,
          loginCustomerId: offline.login_customer_id,
          developerToken: offline.developer_token,
          clientId: offline.client_id,
          clientSecret: offline.client_secret,
          refreshToken: offline.refresh_token,
        },
        current,
        new Date(),
      );
      if (!plan.ok) return json({ success: false, error: plan.error }, 400);
      // ADR-040: `current` was opened, so a kept secret is plaintext here; seal it all again.
      const sealedRow = await sealGoogleAdsOfflineSecrets(database, plan.row);
      const columns = Object.keys(sealedRow) as (keyof typeof sealedRow)[];
      await database.prepare(`
        UPDATE stores SET ${columns.map((column) => `${column} = ?`).join(', ')}
        WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)
      `).bind(...columns.map((column) => sealedRow[column])).run();
    } else {
      return json({ success: false, error: 'Action tidak dikenal.' }, 400);
    }

    const updated = await getAdsRow(database);
    return json({
      success: true,
      message: identityWarning ?? 'Konfigurasi tracking berhasil disimpan.',
      data: updated ? publicConfig(updated) : undefined,
    });
  } catch (error) {
    if (error instanceof CredentialKeyUnavailableError) {
      return json({ success: false, error: CREDENTIAL_KEY_UNAVAILABLE_MESSAGE }, 503);
    }
    console.error('ads-config-put', error);
    return json({ success: false, error: 'Gagal memperbarui konfigurasi iklan & tracking.' }, 500);
  }
};
