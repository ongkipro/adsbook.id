import { openCredential } from "./credential-crypto.ts";

export const DEFAULT_MENGANTAR_BASE_URL = "https://api-public.mengantar.com";
export const DEFAULT_AUTOLARIS_BASE_URL = "https://api-h2h.autolaris.com";

/**
 * The area pair a payment-only `/submit` (`courir_id: 1`) sends when the store
 * saved none (docs/contracts/AUTOLARIS_INTEGRATION_SPEC.md §3). AutoLaris
 * requires origin/destination even for a non-physical order and accepts any
 * valid area; this is the pair from its own published sample, sent with
 * `courir_id: 1` by the TokoΦ integration since the live probe of 2026-08-24.
 * Nothing ships through AutoLaris here, so the pair carries no meaning.
 */
export const AUTOLARIS_DEFAULT_ORIGIN_ID = "3517100";
export const AUTOLARIS_DEFAULT_DESTINATION_ID = "3518010";

type ProviderConfigRow = {
  mengantar_api_key: string | null;
  mengantar_base_url: string | null;
  autolaris_api_key: string | null;
  autolaris_base_url: string | null;
  autolaris_order_origin_id: string | null;
  autolaris_order_destination_id: string | null;
  autolaris_shipper_email: string | null;
};

/**
 * A tenant's provider credentials: what that tenant saved, nothing else
 * (T-45, TEN-4). There is no Worker env fallback — one env key would be every
 * tenant's account. `none` means not configured, and nothing is sent.
 */
export type ProviderConfig = {
  mengantar: {
    apiKey: string;
    baseUrl: string;
    source: "dashboard" | "none";
  };
  autolaris: {
    apiKey: string;
    baseUrl: string;
    /** The `courir_id: 1` area pair for Create Order (`/submit`): the store's own, else the default pair. */
    originId: string;
    destinationId: string;
    /** Whether the pair above is the store's own (false: the default pair). */
    customArea: boolean;
    /** Optional; the buyer's email is the fallback. */
    shipperEmail: string;
    source: "dashboard" | "none";
  };
};

const clean = (value: string | null | undefined) => value?.trim() || "";

/**
 * How a submitted provider credential should change the stored value.
 *
 * An empty submission keeps whatever is stored, so an operator can save the
 * base URL without retyping a secret. An explicit `null` means clear, which
 * leaves the provider not configured.
 */
export function resolveCredentialUpdate(raw: unknown): {
  clear: boolean;
  value: string;
} {
  if (raw === null) return { clear: true, value: "" };
  return { clear: false, value: typeof raw === "string" ? raw.trim() : "" };
}

// lazy: `_locals` is unused since T-45 and kept so the fifteen callers outside
// this task's paths stay untouched; drop it with the next sweep of those files.
export async function getProviderConfig(
  database: D1Database,
  _locals?: App.Locals,
): Promise<ProviderConfig> {
  const row = await database
    .prepare(
      `
    SELECT mengantar_api_key, mengantar_base_url, autolaris_api_key, autolaris_base_url,
      autolaris_order_origin_id, autolaris_order_destination_id, autolaris_shipper_email
    FROM stores
    ORDER BY id
    LIMIT 1
  `,
    )
    .first<ProviderConfigRow>();
  // ADR-040: stored sealed; a value this handle cannot open reads as not set.
  const [mengantarKey, autolarisKey] = await Promise.all([
    openCredential(database, "mengantar_api_key", row?.mengantar_api_key).then((value) => clean(value)),
    openCredential(database, "autolaris_api_key", row?.autolaris_api_key).then((value) => clean(value)),
  ]);

  return {
    mengantar: {
      apiKey: mengantarKey,
      baseUrl: clean(row?.mengantar_base_url) || DEFAULT_MENGANTAR_BASE_URL,
      source: mengantarKey ? "dashboard" : "none",
    },
    autolaris: {
      apiKey: autolarisKey,
      baseUrl: clean(row?.autolaris_base_url) || DEFAULT_AUTOLARIS_BASE_URL,
      // A store's own pair wins only when complete; otherwise the default pair.
      ...autoLarisAreaPair(clean(row?.autolaris_order_origin_id), clean(row?.autolaris_order_destination_id)),
      shipperEmail: clean(row?.autolaris_shipper_email),
      source: autolarisKey ? "dashboard" : "none",
    },
  };
}

/** The store's own area pair when both ids are set and valid, else the default pair. */
export function autoLarisAreaPair(originId: string, destinationId: string): { originId: string; destinationId: string; customArea: boolean } {
  const areaId = (value: string) => /^\d{1,20}$/.test(value) && Number(value) > 0;
  return areaId(originId) && areaId(destinationId)
    ? { originId, destinationId, customArea: true }
    : { originId: AUTOLARIS_DEFAULT_ORIGIN_ID, destinationId: AUTOLARIS_DEFAULT_DESTINATION_ID, customArea: false };
}

/**
 * What AutoLaris Create Order (`/submit`, the QRIS/VA rail) still lacks, or
 * null when it can be sent. For the payment-only profile that is the API key
 * alone (docs/contracts/AUTOLARIS_INTEGRATION_SPEC.md §2): the area pair falls
 * back to the default pair and the shipper to the store's own identity, so a
 * seller who pasted a key is offered QRIS/VA at once. It used to also require
 * a typed area pair and a warehouse address, and QRIS/VA stayed hidden behind
 * two internal AutoLaris ids a seller had no reason to know.
 */
export function autoLarisOrderRailGap(input: { apiKey: string }): string | null {
  if (!input.apiKey.trim()) return "AutoLaris belum dikonfigurasi.";
  return null;
}

/**
 * The AutoLaris order identity an owner submits from /admin/profile: the
 * `courir_id: 1` area pair (positive integers, both or neither) and an
 * optional shipper email. A field left out of the request keeps its stored
 * value; an empty string clears it, which closes the QRIS/VA rail
 * (`autoLarisOrderRailGap`) rather than sending a half-filled order. Anything
 * but a string is refused, never read as a clear.
 */
export function parseAutoLarisOrderIdentity(
  input: { originId?: unknown; destinationId?: unknown; shipperEmail?: unknown },
  current: { originId: string; destinationId: string; shipperEmail: string },
):
  | { ok: true; originId: string | null; destinationId: string | null; shipperEmail: string | null }
  | { ok: false; error: string } {
  const fields = [input.originId, input.destinationId, input.shipperEmail];
  if (fields.some((value) => value !== undefined && value !== null && typeof value !== "string")) {
    return { ok: false, error: "Area dan email AutoLaris harus dikirim sebagai teks." };
  }
  const resolve = (value: unknown, stored: string) =>
    value === undefined ? stored : String(value ?? "").trim();
  const originId = resolve(input.originId, current.originId);
  const destinationId = resolve(input.destinationId, current.destinationId);
  const shipperEmail = resolve(input.shipperEmail, current.shipperEmail).toLowerCase();
  const areaId = (value: string) => /^\d{1,20}$/.test(value) && Number(value) > 0;
  if (Boolean(originId) !== Boolean(destinationId)) {
    return { ok: false, error: "Isi area origin dan destination AutoLaris bersamaan, atau kosongkan keduanya." };
  }
  if (originId && (!areaId(originId) || !areaId(destinationId))) {
    return { ok: false, error: "Area origin/destination AutoLaris harus berupa ID angka positif." };
  }
  if (shipperEmail && (shipperEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipperEmail))) {
    return { ok: false, error: "Email pengirim AutoLaris tidak valid." };
  }
  return {
    ok: true,
    originId: originId || null,
    destinationId: destinationId || null,
    shipperEmail: shipperEmail || null,
  };
}
