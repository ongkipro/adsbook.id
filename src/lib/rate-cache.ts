/**
 * A short per-tenant cache of Mengantar estimates (Paduka, 2026-11-18: "hampir
 * tidak ada delay untuk cek ongkir").
 *
 * The buyer's form quotes a route, then submit-order quotes the same route
 * again to check the price, and a variant or payment switch quotes it a third
 * time: each one was a 300–500 ms Mengantar call. An answer for
 * origin → destination at one weight is reused for `RATE_CACHE_SECONDS`.
 *
 * Rates are account-specific (each seller's own Mengantar key and discount),
 * so the key carries the tenant and its cache version (TEN-3,
 * `tenantCacheKey`): two stores never share an estimate. Only a successful
 * estimate is kept; a refusal or an outage is asked again every time, and the
 * A-415 probes use the raw client. Courier rules are applied after the cache,
 * so an operator's courier switch shows on the next quote.
 *
 * lazy: a seller who replaces their Mengantar key sees the old account's rates
 * for up to RATE_CACHE_SECONDS; upgrade path: put a digest of the key in the
 * cache key.
 */
import type { CourierRateResult } from "./mengantar-client.ts";
import { tenantCacheKey, type TenantScope } from "../platform/keys.ts";

export const RATE_CACHE_SECONDS = 600;

type RateStore = { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> };
type EstimateInput = { originId: string; destinationId: string; weight: number };
type Estimator = (input: EstimateInput) => Promise<CourierRateResult[]>;

function defaultStore(): RateStore | null {
  return (globalThis as { caches?: { default?: RateStore } }).caches?.default ?? null;
}

export function rateCacheKey(scope: TenantScope, input: EstimateInput): Request {
  const query = new URLSearchParams({
    o: input.originId.trim(),
    d: input.destinationId.trim(),
    w: String(input.weight),
  });
  return new Request(tenantCacheKey(scope, "rates.internal", `/mengantar-estimate?${query}`), { method: "GET" });
}

/**
 * `estimate` with a cache in front, or `estimate` itself when there is no
 * tenant scope or no cache (tests, local Node). Never throws because of the
 * cache: a failed read or write only costs the provider call.
 */
export function cachedEstimator(
  estimate: Estimator,
  scope: TenantScope | undefined,
  store: RateStore | null = defaultStore(),
  waitUntil?: (task: Promise<unknown>) => void,
): Estimator {
  if (!scope || !store) return estimate;
  return async (input) => {
    const key = rateCacheKey(scope, input);
    try {
      const hit = await store.match(key);
      if (hit) return (await hit.json()) as CourierRateResult[];
    } catch (error) {
      console.error("rate-cache-read-failed", error);
    }
    const rates = await estimate(input);
    const task = store
      .put(key, new Response(JSON.stringify(rates), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${RATE_CACHE_SECONDS}` },
      }))
      .catch((error) => console.error("rate-cache-write-failed", error));
    if (waitUntil) waitUntil(task);
    else await task;
    return rates;
  };
}
