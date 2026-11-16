import type { APIRoute } from 'astro';
import { jsonError, jsonOk } from '../../../../lib/api.ts';
import { readOrderAttention } from '../../../../lib/order-attention.ts';
import { tenantDatabase } from '../../../../lib/tenant-database.ts';

export const prerender = false;

/**
 * The dashboard's "Perlu tindakan" panel (`order-attention.ts`). Under
 * `/api/admin/orders`, so only the roles that work the order list read it.
 */
export const GET: APIRoute = async ({ locals }) => {
  const database = tenantDatabase(locals);
  if (!database) return jsonError('Database order belum tersedia.', 503);
  try {
    // No env pickup fallback (T-45): a warehouse without its own pickup
    // address is reported as such, not filled from a Worker-wide value.
    const data = await readOrderAttention(database);
    return jsonOk({ data }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    console.error('admin-orders-attention', error);
    return jsonError('Daftar tindakan gagal dimuat.', 500);
  }
};
