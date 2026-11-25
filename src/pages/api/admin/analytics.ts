import type { APIRoute } from 'astro';
import { jsonError, jsonOk } from '../../../lib/api.ts';
import { canAccessAdminRoute } from '../../../lib/auth.ts';
import { readDashboardAnalytics } from '../../../lib/dashboard-analytics.ts';
import { tenantDatabase } from '../../../lib/tenant-database.ts';

export const prerender = false;

const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

export const GET: APIRoute = async ({ locals, url }) => {
  const database = tenantDatabase(locals);
  if (!database || typeof database !== 'object') {
    return jsonError('Database analytics belum tersedia.', 503);
  }

  const startParam = url.searchParams.get('startDate');
  const endParam = url.searchParams.get('endDate');
  if (
    (startParam && !isIsoDate(startParam)) ||
    (endParam && !isIsoDate(endParam))
  ) {
    return jsonError('Rentang tanggal tidak valid.', 400);
  }
  // A half-open range escaped the cap: `?startDate=1970-01-01` alone fell
  // through to an unbounded `>= ?` scan. Requiring both ends keeps every dated
  // request inside the 31-day ceiling; omitting both is still the "all time"
  // request the dashboard's own preset makes.
  if (Boolean(startParam) !== Boolean(endParam)) {
    return jsonError('Tanggal mulai dan akhir harus diisi bersama.', 400);
  }
  if (startParam && endParam) {
    const startTime = Date.parse(`${startParam}T00:00:00.000Z`);
    const endTime = Date.parse(`${endParam}T00:00:00.000Z`);
    if (endTime < startTime || (endTime - startTime) / 86_400_000 > 30) {
      return jsonError('Rentang tanggal maksimal 31 hari.', 400);
    }
  }
  const interval =
    url.searchParams.get('interval') === 'hour' &&
    Boolean(startParam) &&
    startParam === endParam
      ? 'hour'
      : 'day';

  const wantsRankings = (url.searchParams.get('include') || '')
    .split(',')
    .map((part) => part.trim())
    .includes('rankings');
  const adminRole = locals.admin?.role;
  const includeRankings = wantsRankings && Boolean(adminRole && canAccessAdminRoute(adminRole, '/api/admin/insights'));

  try {
    const data = await readDashboardAnalytics(database as D1Database, {
      startDate: startParam,
      endDate: endParam,
      interval,
      preset: url.searchParams.get('preset') || '',
      compare: url.searchParams.get('compare'),
      includeRankings,
    });

    return jsonOk({
      data,
      message: data.total_orders > 0 ? 'Analytics dihitung dari data order D1 saat ini.' : 'Belum ada order untuk dihitung.',
    });
  } catch (error) {
    console.error('admin-analytics-get', error);
    return jsonError('Gagal mengambil data analytics.', 500);
  }
};
