/**
 * A stable-per-day pick from a list.
 *
 * The home hero falls back to catalogue photos when the operator has not
 * uploaded slides of their own, and it should not always be the same three
 * products. A per-request shuffle would do that, and would also change the LCP
 * image on every load — no returning visitor and no second visitor could reuse
 * the bytes already cached, which is the opposite of what the image work was
 * for. Seeding by the date keeps the rotation while letting every visitor that
 * day share one warm set.
 *
 * `seed` is the caller's clock so this stays pure and testable.
 */
export function dailySeed(now: Date): number {
  return (
    now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()
  );
}

export function pickDaily<T>(items: readonly T[], count: number, seed: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];

  // A small LCG. Not cryptography — it only has to be well spread and identical
  // for everyone on the same day.
  let state = (seed % 2147483647) || 1;
  const next = () => (state = (state * 48271) % 2147483647);

  const pool = [...items];
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(...pool.splice(next() % pool.length, 1));
  }
  return picked;
}

/** How many catalogue products the home hero rotates through (owner, 2026-11-23). */
export const HERO_PRODUCT_MIN = 3;
export const HERO_PRODUCT_MAX = 5;

/**
 * The hero's product picks: up to five, chosen per day so every visitor that
 * day shares one warm set of images. Fewer than three products means the
 * catalogue is too small for a rotating hero; the caller shows what there is.
 */
export function pickHeroProducts<T>(items: readonly T[], seed: number): T[] {
  return pickDaily(items, Math.min(HERO_PRODUCT_MAX, items.length), seed);
}

/**
 * One or two lines of a product's description for its slide: the first
 * sentence(s) up to `max` characters, cut at a word, list dashes dropped.
 * Plain text only; Astro escapes it.
 */
export function heroSummary(text: string | null | undefined, max = 110): string {
  // A list dash becomes a comma, except after a sentence's own stop (". - X" → ". X").
  const flat = (text ?? "")
    .replace(/([.!?])\s+[-•*]\s+/g, "$1 ")
    .replace(/\s+[-•*]\s+/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const sentence = flat.slice(0, max + 1).match(/^(.{40,}?[.!?])\s/);
  if (sentence) return sentence[1];
  const cut = flat.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[,;:.\s]+$/, "")}…`;
}
