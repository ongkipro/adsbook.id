/**
 * Where Google's ad consent defaults to denied (Consent Mode v2): the EEA, the UK and
 * Switzerland. The storefront's Google tag (`GoogleAdsBase.astro`) denies by default for
 * these regions and grants elsewhere; the server conversion (`google-data-manager.ts`)
 * follows the same rule, so a buyer the browser treated as non-consenting is never sent
 * as consenting from the server.
 */
export const EEA_UK_CH_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT",
  "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB", "CH",
] as const;

const DENIED_BY_DEFAULT = new Set<string>(EEA_UK_CH_REGIONS);

/**
 * True only for a known, real country outside the EEA/UK/CH. Unknown (no header, `XX`,
 * Tor's `T1`) is not consent: such an order carries click ids and value, never user data.
 */
export function grantsAdUserDataByDefault(country: string | null | undefined): boolean {
  const code = String(country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return false;
  return !DENIED_BY_DEFAULT.has(code);
}
