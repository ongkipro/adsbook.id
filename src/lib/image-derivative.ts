import { CARD_DERIVATIVES } from '../data/card-derivatives.ts';

/**
 * Every image the public storefront shows, at most 480 px wide (owner,
 * 2026-11-23: "480px untuk storefront public biar maksimal dan ringan"; the
 * catalog feeds take the 1024 px JPEG instead, see `feedImagePath`).
 *
 * - An upload dated 2026-11-18 or later is already a WebP at most 480 px wide
 *   (src/lib/image-rules.ts), so it is served as it is. Asking for a `-sm`
 *   twin it never had cost a second R2 lookup and a stand-in the edge would
 *   not cache, on every card.
 * - An older upload can be 1024 to 1280 px; its 480 px `-sm` twin is asked for
 *   instead. `/assets/[...key].ts` falls back to the original when a twin is
 *   missing, so the swap is safe, never a broken tile.
 * - A static image is swapped only when its twin is listed in
 *   CARD_DERIVATIVES (a file under `public/` has no fallback).
 * - Anything else (a remote URL, a `/media/` image, an empty field) is left
 *   exactly as it is.
 */
export const DISPLAY_SIZED_SINCE = '2026-11-18';
const UPLOAD = /^\/assets\/uploads\/(\d{4}-\d{2}-\d{2})\/[0-9a-f-]+\.[a-z0-9]+$/i;

export function storefrontImageSrc(
  url: string,
  derivatives: ReadonlySet<string> = CARD_DERIVATIVES,
): string {
  const trimmed = url?.trim() ?? '';
  if (derivatives.has(trimmed)) return trimmed.replace(/(\.[a-z0-9]+)$/i, '-sm$1');
  const upload = UPLOAD.exec(trimmed);
  if (!upload || /-sm\.[a-z0-9]+$/i.test(trimmed) || upload[1] >= DISPLAY_SIZED_SINCE) return trimmed;
  return trimmed.replace(/(\.[a-z0-9]+)$/i, '-sm$1');
}
