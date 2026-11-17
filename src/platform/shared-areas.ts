/**
 * The cross-tenant kecamatan → Mengantar area cache (PLATFORM_DB
 * `shared_mengantar_areas`, migration 0009). Paduka, 2026-11-18: "pastikan db
 * mengantar kecamatan kota, kodepos dll support multitenant … hampir tidak ada
 * delay untuk cek ongkir".
 *
 * Layers a district resolve walks, fastest first:
 *  1. the tenant's own `mengantar_areas` row (its store, src/lib/mengantar-areas.ts);
 *  2. this shared row, written by whichever store resolved the district first;
 *  3. a live Mengantar `/address/search` with the tenant's own key.
 * A live exact answer is written to both.
 *
 * Why sharing is safe (TEN-3): the value is public geography — Mengantar's
 * area ids are the same for every seller account; only rates are
 * account-specific, and rates are never cached here. The key holds no tenant,
 * order, buyer or credential. A refused destination (A-415) drops the row
 * here as well as in the tenant store.
 */
import { buildMengantarAreaKey, MENGANTAR_AREA_MAX_AGE_DAYS } from "../lib/mengantar-areas.ts";

type District = { district: string; city: string; province: string };

/** The control plane database from the Worker env; the only place outside the gate that names it for this table. */
function platformDb(env: unknown): D1Database | undefined {
  const db = (env as { PLATFORM_DB?: D1Database } | null | undefined)?.PLATFORM_DB;
  return db?.prepare ? db : undefined;
}

/** The layer `resolveMengantarArea` takes; undefined when there is no control plane (single-store dev). */
export function sharedAreaLayer(env: unknown): { read(input: District): Promise<string | null>; write(input: District, body: string): Promise<boolean> } | undefined {
  const db = platformDb(env);
  if (!db) return undefined;
  return { read: (input) => readSharedArea(db, input), write: (input, body) => writeSharedArea(db, input, body) };
}

/** `dropRefusedDestination`'s shared leg for this env. */
export function sharedAreaDropper(env: unknown): ((areaId: string, resolvedBefore: Date) => Promise<number>) | undefined {
  const db = platformDb(env);
  return db ? (areaId, resolvedBefore) => dropSharedArea(db, areaId, resolvedBefore) : undefined;
}

/** A shared row newer than the tenant bound answers; older is a miss (same bound as the tenant store). */
export async function readSharedArea(platformDb: D1Database | undefined, input: District, now: Date = new Date()): Promise<string | null> {
  if (!platformDb?.prepare) return null;
  const freshSince = new Date(now.getTime() - MENGANTAR_AREA_MAX_AGE_DAYS * 86_400_000).toISOString();
  const row = await platformDb
    .prepare("SELECT payload FROM shared_mengantar_areas WHERE area_key = ? AND resolved_at >= ?")
    .bind(buildMengantarAreaKey(input.district, input.city, input.province), freshSince)
    .first<{ payload: string }>();
  return row?.payload ?? null;
}

/** Keep an exact resolve body for every tenant. Only a body with an area id is kept. */
export async function writeSharedArea(platformDb: D1Database | undefined, input: District, body: string, now: Date = new Date()): Promise<boolean> {
  if (!platformDb?.prepare) return false;
  const first = (JSON.parse(body) as { items?: Array<{ id?: string; label?: string; postal_code?: string }> }).items?.[0];
  if (!first?.id) return false;
  await platformDb
    .prepare(
      `INSERT INTO shared_mengantar_areas (area_key, area_id, label, postal_code, payload, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(area_key) DO UPDATE SET
         area_id = excluded.area_id, label = excluded.label, postal_code = excluded.postal_code,
         payload = excluded.payload, resolved_at = excluded.resolved_at`,
    )
    .bind(buildMengantarAreaKey(input.district, input.city, input.province), first.id, first.label ?? "", first.postal_code ?? "", body, now.toISOString())
    .run();
  return true;
}

/** Forget a destination Mengantar refused (A-415), only rows resolved before the failed quote. */
export async function dropSharedArea(platformDb: D1Database | undefined, areaId: string, resolvedBefore: Date): Promise<number> {
  const id = areaId.trim();
  if (!platformDb?.prepare || !id) return 0;
  const result = await platformDb
    .prepare("DELETE FROM shared_mengantar_areas WHERE area_id = ? AND resolved_at <= ?")
    .bind(id, resolvedBefore.toISOString())
    .run();
  return Number(result.meta?.changes ?? 0);
}
