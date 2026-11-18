/**
 * "Masuk ke toko" for a returning seller (UX-1): what they type — a slug, a
 * store name, an own domain or a pasted URL — becomes the store's `/hello`.
 * Browser code: the signup page's finder and the home hero's account dialog
 * both use it, so the two never disagree on what a store address is.
 * Imported by client scripts only; nothing here reaches a seller host.
 */

/** The home hero's "Daftar" email, carried to /daftar in sessionStorage — never in a URL the platform Pixel reports. */
export const HERO_EMAIL_KEY = "adsbook:signup-email";

/** A store name or a typed slug as a subdomain label: the signup page's rule (3–32 characters). */
export const toSlug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

export type StoreLogin = { url: string } | { error: string };

/**
 * The login URL on the store's own host. `suffix` is the seller zone
 * (`adsbook.my.id`, or `localhost` in local development, where the page's
 * own port is kept); `current` is the page's own `location`.
 */
export function storeLoginUrl(raw: string, suffix: string, current: { protocol: string; port: string }): StoreLogin {
  const typed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (!typed) return { error: "Masukkan slug atau domain toko Anda." };
  const host = typed.includes(".") ? typed : `${toSlug(typed)}.${suffix}`;
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return { error: "Format alamat toko tidak valid." };
  }
  const port = current.port && !host.includes(":") && suffix === "localhost" ? `:${current.port}` : "";
  const protocol = current.protocol === "http:" && suffix === "localhost" ? "http:" : "https:";
  return { url: `${protocol}//${host}${port}/hello` };
}
