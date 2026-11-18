import type { APIRoute } from 'astro';
import { readMetaBrowserIds, readTikTokBrowserIds } from '../../lib/click-ids.ts';
import { checkRateLimit, getClientIp, rateLimitHeaders } from '../../lib/rate-limit.ts';
import { getStoreAdsConfig } from '../../lib/store-ads.ts';
import { tenantDatabase } from '../../lib/tenant-database.ts';
import { buildTikTokUserData, tikTokProperties, validateTikTokFunnelPayload } from '../../lib/tiktok-events.ts';
import { deliverTikTokEvent, drainTikTokOutbox, enqueueTikTokEvent } from '../../lib/tiktok-outbox.ts';

export const prerender = false;

const json = (body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/**
 * The server twin of a TikTok funnel event (tracking chapter 11 §2.3):
 * ViewContent, AddToCart, InitiateCheckout, sharing the browser event's
 * `event_id`. CompletePayment is refused here: it leaves from the order
 * (`tiktok-outbox.ts`), never from a browser claim. Rate-limited like
 * `/api/meta-event`, because fabricated funnel events would degrade the
 * seller's optimisation data and burn their Events API quota.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const database = tenantDatabase(locals);
    const clientIp = getClientIp(request.headers);
    const rateLimit = await checkRateLimit(database, `public-tiktok-event:${clientIp}`, 60, 60_000);
    if (!rateLimit.allowed) {
      return json(
        { success: false, error: 'Terlalu banyak event. Coba lagi sebentar.', code: 'RATE_LIMITED' },
        429,
        rateLimitHeaders(rateLimit.remaining, rateLimit.resetAt),
      );
    }
    const validated = validateTikTokFunnelPayload(await request.json().catch(() => null), request.url);
    if (validated.ok === false) return json({ success: false, error: validated.error }, 400);
    const payload = validated.value;

    // ADR-041: empty while ad signals are paused, so nothing is stored or sent.
    const ads = await getStoreAdsConfig(locals);
    if (!ads.tiktokPixelId || !ads.tiktokAccessToken) {
      return json({ success: true, skipped: true, reason: 'TikTok Events API is not configured for this store.' }, 202);
    }
    if (!database?.prepare) return json({ success: false, error: 'Event store belum tersedia.' }, 503);

    const tiktokIds = readTikTokBrowserIds(request);
    const event = {
      event: payload.event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: payload.eventId,
      user: await buildTikTokUserData({
        phone: payload.phone,
        externalId: readMetaBrowserIds(request).externalId,
        ttclid: tiktokIds.ttclid,
        ttp: tiktokIds.ttp,
        ip: clientIp,
        userAgent: request.headers.get('user-agent'),
        locale: request.headers.get('accept-language')?.split(/[,;]/)[0],
      }),
      properties: tikTokProperties({ value: payload.value, contents: payload.contents }),
      page: { url: payload.url },
    };
    const queued = await enqueueTikTokEvent(database, event);
    if (!queued) return json({ success: true, deduplicated: true }, 200);
    const destination = { pixelId: ads.tiktokPixelId, accessToken: ads.tiktokAccessToken };
    const delivered = await deliverTikTokEvent(database, event.event, event.event_id, destination);
    const drain = drainTikTokOutbox(database, destination).catch((error) => console.error('tiktok-outbox-drain', error));
    if (locals.cfContext) locals.cfContext.waitUntil(drain);
    else void drain;
    return json({ success: true, delivered, queued: !delivered }, 200);
  } catch (error) {
    console.error('tiktok-event', error);
    return json({ success: false, error: 'TikTok event error' }, 500);
  }
};
