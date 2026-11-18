/**
 * A store name or a typed slug as a subdomain label, the signup page's rule
 * (3–32 characters). Browser code for /daftar. (The returning seller's
 * slug finder and the header dialog it served were replaced by adsbook.id/masuk,
 * which finds the store from the email or username: AUTH-LOGIN-REGISTER-UX-SPEC.)
 */
export const toSlug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
