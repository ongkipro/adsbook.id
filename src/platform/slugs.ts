/**
 * The tenant slug rule and reserved list (`docs/spec/05-DATA-MODEL.md` §4.1).
 * A slug is one DNS label under `adsbook.my.id`, never renamed in v1. Checked at
 * signup before any write.
 */

/** Every record the `adsbook.my.id` zone holds (08-DOMAIN-ROUTING.md §3, zone table). */
export const SELLER_ZONE_RECORDS = ["@", "*", "fallback", "cname"] as const;

/**
 * Labels no tenant may take: each non-wildcard record of the zone (a tenant
 * with such a slug would shadow the CNAME target or the fallback origin),
 * `www`, and platform-sounding names. `demo` is deliberately absent: the
 * demo seed claims it through the normal signup (PR-26).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "cname",
  "fallback",
  "www",
  "app",
  "api",
  "admin",
  "adsbook",
  "belanja",
  "platform",
  "support",
  "help",
  "status",
  "mail",
  "cdn",
  "static",
  "assets",
]);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

export type SlugCheck = { ok: true; slug: string } | { ok: false; error: string; reserved?: boolean };

export function checkSlug(raw: unknown): SlugCheck {
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  // `ab--…` is the shape of an IDN A-label (`xn--`): never a slug.
  if (!SLUG.test(slug) || /^..--/.test(slug)) {
    return { ok: false, error: "Alamat toko 3–32 karakter: huruf kecil, angka, dan tanda hubung di tengah." };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: "Alamat toko ini tidak tersedia.", reserved: true };
  return { ok: true, slug };
}

/** A slug suggestion from a store name: what the signup form prefills. */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

const SUGGESTION_SUFFIXES = ["id", "official", "store", "shop", "online", "mart", "jaya", "kita", "asli"] as const;

/**
 * UX-1 exception map: when a requested slug is taken or reserved, suggest up to
 * `limit` (default 3) valid, unreserved, unclaimed alternatives derived from
 * the seller's own base name.
 */
export async function suggestFreeSlugs(
  platformDb: D1Database,
  rawBase: string,
  limit = 3,
): Promise<string[]> {
  let base = slugFromName(rawBase);
  if (base.length < 2 || RESERVED_SLUGS.has(base)) {
    base = base ? `toko-${base}`.slice(0, 24).replace(/-+$/g, "") : "toko";
  }
  const candidates: string[] = [];
  const push = (candidate: string) => {
    const checked = checkSlug(candidate);
    if (checked.ok && !candidates.includes(checked.slug)) candidates.push(checked.slug);
  };
  for (const suffix of SUGGESTION_SUFFIXES) {
    const trimmed = base.slice(0, Math.max(2, 31 - suffix.length)).replace(/-+$/g, "");
    push(`${trimmed}-${suffix}`);
  }
  for (let n = 2; n <= 9; n += 1) {
    const trimmed = base.slice(0, 30).replace(/-+$/g, "");
    push(`${trimmed}-${n}`);
  }
  if (!candidates.length) return [];
  const sample = candidates.slice(0, 12);
  const placeholders = sample.map(() => "?").join(", ");
  const takenRows = (
    await platformDb
      .prepare(`SELECT slug FROM tenants WHERE slug IN (${placeholders})`)
      .bind(...sample)
      .all<{ slug: string }>()
  ).results;
  const taken = new Set(takenRows.map((row) => row.slug));
  return sample.filter((slug) => !taken.has(slug)).slice(0, limit);
}
