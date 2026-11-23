import { CARD_DERIVATIVES } from '../data/card-derivatives.ts';

/**
 * The catalogue card renders at 182 CSS px, which is 478 device pixels on the
 * phone Lighthouse emulates, while the product detail view renders at 480 CSS
 * px and genuinely wants the full upload. One file cannot serve both without
 * wasting most of its bytes on the card, so a card-sized derivative lives
 * beside the original as `<name>-sm.<ext>`.
 *
 * `/assets/[...key].ts` falls back to the original when the derivative is
 * absent, so calling this on an image that has none is safe — it costs the old
 * number of bytes rather than breaking the tile.
 */
// lazy: since 2026-11-18 every upload is already 480 px wide (image-rules.ts),
// so new uploads store no `-sm` twin and a card's `-sm` request falls back to
// the 480 px original (one extra R2 lookup, 10-minute stand-in cache). Older
// uploads keep their twins. Upgrade path: drop the swap for uploads dated
// 2026-11-18 or later once their share of traffic makes the lookup matter.
export function cardImageSrc(
  url: string,
  derivatives: ReadonlySet<string> = CARD_DERIVATIVES,
): string {
  const trimmed = url?.trim() ?? '';
  // A static image has no server-side fallback, so only a listed one is swapped.
  if (derivatives.has(trimmed)) return trimmed.replace(/(\.[a-z0-9]+)$/i, '-sm$1');
  if (!trimmed.startsWith('/assets/uploads/')) return trimmed;
  if (/-sm\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  return trimmed.replace(/(\.[a-z0-9]+)$/i, '-sm$1');
}

/**
 * The home hero's sources (PageSpeed, 2026-11-23: the first slide is the LCP
 * image and shipped a 1280 px, 203 KB original into a column at most 480 CSS
 * px wide). A 1x screen takes the 480 px card derivative; 2x and up take the
 * upload. Same fallback as `cardImageSrc`: a missing `-sm` serves the original.
 */
export function heroImageSources(url: string, derivatives: ReadonlySet<string> = CARD_DERIVATIVES): { src: string; srcset: string; sizes: string } {
  const original = url?.trim() ?? '';
  const small = cardImageSrc(original, derivatives);
  const sizes = '(max-width: 480px) 100vw, 480px';
  if (small === original) return { src: original, srcset: '', sizes };
  return { src: small, srcset: `${small} 480w, ${original} 960w`, sizes };
}
