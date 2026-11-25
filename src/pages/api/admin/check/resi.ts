import type { APIRoute } from 'astro';
import { jsonError, jsonOk } from '../../../../lib/api';
import {
  MengantarClient,
  mapMengantarStatusEvidence,
  type MengantarTrackingHistory,
} from '../../../../lib/mengantar-client';
import { getProviderConfig } from '../../../../lib/provider-config';
import { tenantDatabase } from '../../../../lib/tenant-database.ts';

export const prerender = false;

type LocalOrderRow = {
  order_number: string;
  customer_name: string | null;
  courier_code: string | null;
  cnote_no: string | null;
  shipping_status: string | null;
  payment_method: string | null;
  total_amount: number | null;
  created_at: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Menunggu proses',
  confirmed: 'Siap dikirim',
  processing: 'Sedang diproses kurir',
  dispatched: 'Menunggu pickup',
  pickup_scheduled: 'Pickup terjadwal',
  picked_up: 'Sudah di-pickup',
  shipped: 'Dalam pengiriman',
  in_transit: 'Dalam pengiriman',
  out_for_delivery: 'Sedang diantar kurir',
  delivered: 'Terkirim',
  returned: 'Retur (RTS)',
  rts: 'Retur (RTS)',
  cancelled: 'Dibatalkan',
  failed: 'Gagal kirim',
};

function normalizeHistory(history: readonly MengantarTrackingHistory[] | undefined) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item): item is MengantarTrackingHistory => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      date: String(item.date || item.created_at || '').trim(),
      time: String(item.time || '').trim(),
      status: String(item.status || '').trim(),
      desc: String(item.desc || item.description || item.status || '').trim(),
      location: String(item.location || '').trim(),
    }))
    .filter((item) => Boolean(item.desc || item.status));
}

export const GET: APIRoute = async ({ url, locals }) => {
  const rawQuery = String(url.searchParams.get('q') || url.searchParams.get('cnote') || '').trim();
  if (rawQuery.length < 3 || rawQuery.length > 64) {
    return jsonError('Masukkan nomor resi atau nomor invoice (3–64 karakter).', 400);
  }

  const database = tenantDatabase(locals);
  if (!database?.prepare) {
    return jsonError('Database order belum tersedia.', 503);
  }

  let localOrder: LocalOrderRow | null = null;
  try {
    localOrder = await database
      .prepare(
        `SELECT order_number, customer_name, courier_code, cnote_no, shipping_status, payment_method, total_amount, created_at
         FROM orders
         WHERE LOWER(cnote_no) = LOWER(?) OR LOWER(order_number) = LOWER(?)
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(rawQuery, rawQuery)
      .first<LocalOrderRow>();
  } catch (error) {
    console.error('admin-check-resi-local', error instanceof Error ? error.message : 'unknown');
  }

  const resolvedCnote = String(localOrder?.cnote_no || '').trim() || (localOrder ? '' : rawQuery);
  const config = await getProviderConfig(database, locals);
  const providerConfigured = Boolean(config.mengantar.apiKey);

  let trackingPayload: {
    cnoteNo: string;
    providerOrderId: string | null;
    courier: string | null;
    shippingStatus: string;
    statusLabel: string;
    latestEvent: string | null;
    history: ReturnType<typeof normalizeHistory>;
  } | null = null;
  let providerError: string | null = null;

  if (resolvedCnote && providerConfigured) {
    try {
      const client = new MengantarClient(config.mengantar.apiKey, config.mengantar.baseUrl);
      const rawTracking = await client.getOrderByTrackingId(resolvedCnote);
      const mapped = mapMengantarStatusEvidence(rawTracking);
      const history = normalizeHistory(rawTracking.history);
      const status = mapped.shippingStatus ?? (localOrder?.shipping_status || 'in_transit');
      trackingPayload = {
        cnoteNo: String(rawTracking.cnote_no || resolvedCnote),
        providerOrderId: rawTracking.ORDER_ID ? String(rawTracking.ORDER_ID) : null,
        courier: localOrder?.courier_code || null,
        shippingStatus: status,
        statusLabel: STATUS_LABELS[status] || status,
        latestEvent: mapped.description || history[0]?.desc || null,
        history,
      };
    } catch (error) {
      providerError = error instanceof Error && error.message
        ? error.message
        : 'Data pelacakan Mengantar belum tersedia.';
    }
  } else if (!providerConfigured) {
    providerError = 'API key Mengantar belum dikonfigurasi. Atur di Profil & Integrasi untuk melacak resi langsung.';
  } else if (localOrder && !resolvedCnote) {
    providerError = 'Pesanan ini ditemukan di toko tetapi belum memiliki nomor resi dari kurir.';
  }

  if (!trackingPayload && !localOrder) {
    return jsonError(
      providerError || 'Nomor resi atau invoice tidak ditemukan di Mengantar maupun daftar pesanan toko.',
      404,
    );
  }

  return jsonOk({
    query: rawQuery,
    cnote: trackingPayload?.cnoteNo || resolvedCnote || null,
    providerConfigured,
    providerError,
    order: localOrder
      ? {
          orderNumber: localOrder.order_number,
          customerName: localOrder.customer_name || 'Pembeli',
          courierCode: localOrder.courier_code || '',
          cnoteNo: localOrder.cnote_no || '',
          shippingStatus: localOrder.shipping_status || 'pending',
          shippingStatusLabel: STATUS_LABELS[localOrder.shipping_status || 'pending'] || localOrder.shipping_status || 'Menunggu',
          paymentMethod: localOrder.payment_method || '',
          totalAmount: Number(localOrder.total_amount || 0),
          createdAt: localOrder.created_at || '',
          detailHref: `/admin/orders/${encodeURIComponent(localOrder.order_number)}`,
        }
      : null,
    tracking: trackingPayload,
  });
};
