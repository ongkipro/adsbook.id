import { activeThanksNumbers } from "./whatsapp-numbers.ts";
import { tenantDatabase } from "./tenant-database.ts";

export async function getStoreSupportWhatsapp(
  locals?: App.Locals,
): Promise<string> {
  const database = tenantDatabase(locals);
  if (!database || typeof database !== "object") {
    // No binding at all: every surface that offers support loses its contact
    // route, and the storefront renders as if support were unconfigured.
    console.error("storefront-support-whatsapp-no-database-binding");
    return "";
  }

  try {
    const store = await (database as D1Database)
      .prepare("SELECT support_whatsapp FROM stores ORDER BY id LIMIT 1")
      .first<{ support_whatsapp: string | null }>();
    if (!store) {
      // No row at all is a different failure from a row with no number saved:
      // the database is migrated but the store was never seeded, so every
      // other stores-backed read on this install is failing too.
      console.error("storefront-support-whatsapp-no-store-row");
      return "";
    }
    // Stored as typed in the admin, often `08…`; every consumer builds a
    // `wa.me/<number>` link, which only resolves in international form.
    return (store.support_whatsapp?.replace(/\D/g, "") || "").replace(/^0/, "62");
  } catch (error) {
    console.error("storefront-support-whatsapp-load", error);
    return "";
  }
}

/**
 * The store's public contact for its legal and contact pages: the first CS
 * WhatsApp in international form with a leading +, and the optional email and
 * business address from Pengaturan → Store (migration 0078). Empty strings for
 * anything unset or unreadable; the pages then drop the sentence that needs it.
 */
export async function getStorePublicContact(locals?: App.Locals): Promise<{
  whatsapp: string;
  email: string;
  address: string;
}> {
  const whatsapp = await getStoreSupportWhatsapp(locals);
  const contact = { whatsapp: whatsapp ? `+${whatsapp}` : "", email: "", address: "" };
  const database = tenantDatabase(locals);
  if (!database || typeof database !== "object") return contact;
  try {
    const row = await (database as D1Database)
      .prepare("SELECT support_email, business_address FROM stores ORDER BY id LIMIT 1")
      .first<{ support_email: string | null; business_address: string | null }>();
    contact.email = row?.support_email?.trim() || "";
    contact.address = row?.business_address?.trim() || "";
  } catch (error) {
    console.error("storefront-public-contact-load", error instanceof Error ? error.message : "unknown");
  }
  return contact;
}

/**
 * What /thanks needs for its WhatsApp hand-off: the support numbers the
 * rotator picks from (PRD A35, `activeThanksNumbers`) and whether the operator
 * turned the automatic redirect on (migration 0060). Any failure reads as
 * "off" — the page then shows its button, as it always has.
 */
export async function getThanksWhatsappSettings(
  locals?: App.Locals,
): Promise<{ phones: string[]; autoRedirect: boolean }> {
  const database = tenantDatabase(locals);
  if (!database || typeof database !== "object") {
    console.error("storefront-support-whatsapp-no-database-binding");
    return { phones: [], autoRedirect: false };
  }
  const phones = await activeThanksNumbers(database as D1Database);
  if (!phones.length) return { phones, autoRedirect: false };
  try {
    const row = await (database as D1Database)
      .prepare("SELECT thanks_whatsapp_redirect FROM stores ORDER BY id LIMIT 1")
      .first<{ thanks_whatsapp_redirect: number | null }>();
    return { phones, autoRedirect: Number(row?.thanks_whatsapp_redirect) === 1 };
  } catch (error) {
    console.error("storefront-thanks-whatsapp-redirect-load", error);
    return { phones, autoRedirect: false };
  }
}

type PublicPaymentRow = { payment_method: string; name: string; is_active: boolean; logo_url?: string | null };

/** "A", "A dan B", "A, B, dan C". */
export function joinIndonesian(items: readonly string[]) {
  if (items.length < 3) return items.join(" dan ");
  return `${items.slice(0, -1).join(", ")}, dan ${items[items.length - 1]}`;
}

/** BCA, BNI, BRI and BSI are spelt in capitals; MANDIRI reads Mandiri. */
const bankName = (name: string) =>
  name.length <= 4 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

/**
 * The payment methods a buyer can actually choose, as one phrase per kind:
 * "COD (bayar di tempat)", "QRIS", "Virtual Account BCA, Mandiri…", "transfer
 * bank Mandiri". Read from `/api/payment-methods`, so a static page never
 * names a method the checkout no longer offers.
 */
export function summarizePaymentMethods(rows: readonly PublicPaymentRow[]) {
  const active = rows.filter((row) => row.is_active);
  const banks = (method: string, prefix: RegExp) =>
    active.filter((row) => row.payment_method === method).map((row) => bankName(row.name.replace(prefix, "").trim()));
  const va = banks("bank_transfer", /^Virtual Account\s*/i);
  const manual = [...new Set(banks("manual_transfer", /^Transfer Bank\s*/i))];
  return [
    ...(active.some((row) => row.payment_method === "cod") ? ["COD (bayar di tempat)"] : []),
    ...(active.some((row) => row.payment_method === "qris") ? ["QRIS"] : []),
    ...(va.length ? [`Virtual Account ${va.join(", ")}`] : []),
    ...(manual.length ? [`transfer bank ${manual.join(", ")}`] : []),
  ];
}

/**
 * What a storefront page may state about the store's logistics and payments,
 * read from the same settings the checkout uses (enabled courier rules, the
 * payment-methods answer, the store's non-COD provinces). Hand-written copy
 * named seven couriers and one bank while the checkout offered five and six
 * (revenleather, 2026-11-02). Nothing here varies per visitor, so a page that
 * prints it stays edge-cacheable.
 */
export async function getStorePublicFacts(locals: App.Locals): Promise<{
  couriers: string[];
  courierLogos: Array<{ name: string; logo: string }>;
  payments: string[];
  paymentLogos: Array<{ name: string; logo: string }>;
  codExcludedProvinces: string[];
}> {
  const facts = {
    couriers: [] as string[],
    courierLogos: [] as Array<{ name: string; logo: string }>,
    payments: [] as string[],
    paymentLogos: [] as Array<{ name: string; logo: string }>,
    codExcludedProvinces: [] as string[],
  };
  const database = tenantDatabase(locals);
  const [{ courierDisplayName, courierLogoUrl }, { loadStoreCodDisabledProvinceCodes }, { getProvinceName }, { GET }] = await Promise.all([
    import("./courier-names.ts"),
    import("./form-mode.ts"),
    import("./province.ts"),
    import("../pages/api/payment-methods.ts"),
  ]);
  try {
    const rules = database?.prepare
      ? await database.prepare("SELECT courier_code FROM courier_rules WHERE is_enabled = 1 ORDER BY id").all<{ courier_code: string }>()
      : null;
    const rows = rules?.results ?? [];
    facts.couriers = [...new Set(rows.map((row) => courierDisplayName(row.courier_code)))];
    const seenLogos = new Set<string>();
    for (const row of rows) {
      const logo = courierLogoUrl(row.courier_code);
      if (!logo || seenLogos.has(logo)) continue;
      seenLogos.add(logo);
      facts.courierLogos.push({ name: courierDisplayName(row.courier_code), logo });
    }
    facts.codExcludedProvinces = (await loadStoreCodDisabledProvinceCodes(database)).map((code) => getProvinceName(code)).filter(Boolean);
    const response = await GET({ locals } as Parameters<typeof GET>[0]);
    const payload = (await response.json()) as { data?: PublicPaymentRow[] };
    const paymentRows = payload.data ?? [];
    facts.payments = summarizePaymentMethods(paymentRows);
    const seenPayments = new Set<string>();
    for (const row of paymentRows) {
      if (!row.is_active || !row.logo_url || seenPayments.has(row.logo_url)) continue;
      seenPayments.add(row.logo_url);
      facts.paymentLogos.push({ name: row.name, logo: row.logo_url });
    }
  } catch (error) {
    console.error("storefront-public-facts-load", error instanceof Error ? error.message : "unknown");
  }
  return facts;
}

/**
 * The storefront trust strip (compact storefront, 2026-11-23):
 * at most three short claims, each true of this store's live settings, in the
 * order a buyer weighs them. Nothing is said that the checkout would not honour:
 * no COD claim without an active COD method, no courier without an enabled rule.
 */
export function storefrontTrustSignals(facts: { couriers: readonly string[]; payments: readonly string[] }): Array<{
  icon: "wallet" | "credit-card" | "truck";
  /** The full claim, read by assistive technology. */
  label: string;
  /** What the 480px strip shows: two short lines at most. */
  short: string;
}> {
  const signals: Array<{ icon: "wallet" | "credit-card" | "truck"; label: string; short: string }> = [];
  const payments = facts.payments;
  if (payments.some((payment) => payment.startsWith("COD"))) signals.push({ icon: "wallet", label: "Bisa bayar di tempat (COD)", short: "Bisa COD" });
  const online = [
    payments.some((payment) => payment === "QRIS") && "QRIS",
    payments.some((payment) => payment.startsWith("Virtual Account")) && "Virtual Account",
    payments.some((payment) => payment.startsWith("transfer bank")) && "transfer bank",
  ].filter((item): item is string => Boolean(item));
  if (online.length) {
    const shortNames: Record<string, string> = { QRIS: "QRIS", "Virtual Account": "VA", "transfer bank": "Transfer" };
    signals.push({ icon: "credit-card", label: `Bayar via ${joinIndonesian(online)}`, short: online.map((item) => shortNames[item]).join(" · ") });
  }
  const couriers = facts.couriers.filter(Boolean);
  if (couriers.length) {
    const shown = couriers.slice(0, 3);
    const extra = couriers.length > shown.length ? ` +${couriers.length - shown.length}` : "";
    signals.push({ icon: "truck", label: `Dikirim ${shown.join(", ")}${extra}`, short: `${couriers.slice(0, 2).join(", ")}${couriers.length > 2 ? ` +${couriers.length - 2}` : ""}` });
  }
  return signals;
}


/**
 * A seller's plain-text description, as paragraphs and bullet lists: lines
 * (or " - " runs inside one line, as the catalogue import writes them)
 * starting with "-", "•" or "*" become list items. Text only; nothing is
 * interpreted as markup, so a description can never inject HTML.
 */
export function descriptionBlocks(text: string): Array<{ kind: "p"; text: string } | { kind: "ul"; items: string[] }> {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+[-•*]\s+(?=\S)/g, "\n- ");
  const blocks: Array<{ kind: "p"; text: string } | { kind: "ul"; items: string[] }> = [];
  for (const raw of normalized.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-•*]\s*(.+)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
    } else if (last?.kind === "p") {
      last.text = `${last.text} ${line}`;
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}
