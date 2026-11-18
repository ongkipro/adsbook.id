import { readinessTrack, readReadiness, type ReadinessFacts } from "../platform/readiness.ts";
import { getRuntimeEnv } from "./env.ts";

/**
 * The seller's setup checklist (UX-2, T-38): ordered steps, each done or not
 * from the store's own data on every render — nothing about the checklist is
 * stored. The `required` ("wajib") steps are exactly the PR-23 ready predicate
 * (`src/platform/readiness.ts`), so the checklist says ready exactly when the
 * storefront opens to buyers.
 */
export type SetupFacts = ReadinessFacts & { customDomain: boolean };

export type SetupStep = {
  id: "store" | "product" | "warehouse" | "mengantar" | "couriers" | "payment" | "domain" | "signals";
  label: string;
  hint: string;
  href: string;
  done: boolean;
  required: boolean;
};

export function buildSetupChecklist(facts: SetupFacts): SetupStep[] {
  const optional: SetupStep[] = [
    {
      id: "domain",
      label: "Pasang domain sendiri",
      hint: "Opsional. Toko tetap bisa jualan di alamat adsbook.my.id.",
      href: "/admin/settings/domains",
      done: facts.customDomain,
      required: false,
    },
    {
      id: "signals",
      label: "Pasang Meta Pixel atau Google Ads",
      hint: "Opsional. Agar iklan belajar dari pesanan.",
      href: "/admin/ads",
      done: facts.signals,
      required: false,
    },
  ];
  // DIGITAL-PRODUCTS-SPEC §3: the digital track owes three steps, nothing that ships.
  if (readinessTrack(facts) === "digital") {
    return [
      {
        id: "store",
        label: "Isi identitas toko",
        hint: "Nama toko yang dilihat pembeli.",
        href: "/admin/settings/store",
        done: facts.storeName,
        required: true,
      },
      {
        id: "product",
        label: "Tambah produk digital pertama + link akses",
        hint: "Produk digital aktif dengan harga dan link akses https:// yang dibuka setelah lunas.",
        href: "/admin/products",
        done: facts.digitalProduct,
        required: true,
      },
      {
        id: "payment",
        label: "Aktifkan pembayaran QRIS/VA atau Transfer Bank",
        hint: "AutoLaris dengan API key, atau minimal satu rekening bank aktif. Produk digital tidak memakai COD.",
        href: "/admin/payments",
        done: facts.prepaid,
        required: true,
      },
      // A hybrid store selling digital with physical products waiting: what those still owe.
      ...(facts.catalogMode === "hybrid" && facts.physicalCatalog
        ? ([
            { id: "warehouse", label: "Lengkapi alamat pickup / gudang utama", hint: "Wajib untuk menjual produk fisik. Produk digital tetap jualan tanpa gudang.", href: "/admin/settings/warehouse", done: facts.primaryWarehouse, required: false },
            { id: "mengantar", label: "Simpan API key Mengantar", hint: "Wajib untuk ongkir dan resi produk fisik.", href: "/admin/profile", done: facts.mengantar, required: false },
            { id: "couriers", label: "Aktifkan minimal satu kurir", hint: "Wajib untuk mengirim produk fisik.", href: "/admin/expeditions", done: facts.enabledCouriers > 0, required: false },
          ] satisfies SetupStep[])
        : []),
      ...optional,
    ];
  }
  return [
    {
      id: "store",
      label: "Isi identitas toko",
      hint: "Nama toko yang dilihat pembeli.",
      href: "/admin/settings/store",
      done: facts.storeName,
      required: true,
    },
    {
      id: "product",
      label: "Tambah produk fisik pertama",
      hint: "Produk aktif dengan harga dan berat: dipakai checkout dan hitung ongkir.",
      href: "/admin/products",
      done: facts.product,
      required: true,
    },
    {
      id: "warehouse",
      label: "Lengkapi alamat pickup / gudang utama",
      hint: "Area origin dan alamat pickup Mengantar di gudang utama. Gudang lain tidak menggantikannya.",
      href: "/admin/settings/warehouse",
      done: facts.primaryWarehouse,
      required: true,
    },
    {
      id: "mengantar",
      label: "Simpan API key Mengantar",
      hint: "Untuk ongkir, COD, dan resi. Disimpan di database toko Anda.",
      href: "/admin/profile",
      done: facts.mengantar,
      required: true,
    },
    {
      // Install seeds the default couriers, so this is open only when every one
      // was switched off: checkout then quotes nothing.
      id: "couriers",
      label: "Aktifkan minimal satu kurir",
      hint: "Tanpa kurir aktif, ongkir tidak bisa dihitung.",
      href: "/admin/expeditions",
      done: facts.enabledCouriers > 0,
      required: true,
    },
    {
      id: "payment",
      label: "Aktifkan metode bayar",
      hint: "COD, atau AutoLaris (QRIS/VA) dengan API key dan area order lengkap.",
      href: "/admin/payments",
      done: facts.payment,
      required: true,
    },
    ...optional,
  ];
}

/** Null when the facts cannot be read: no panel beats a wrong one. */
export async function readSetupFacts(
  database: D1Database | undefined,
  locals: App.Locals,
): Promise<SetupFacts | null> {
  if (!database) return null;
  try {
    const tenantId = locals.tenantContext?.tenantId;
    const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
    const [facts, custom] = await Promise.all([
      readReadiness(database),
      platformDb && tenantId
        ? platformDb
            .prepare("SELECT 1 AS yes FROM tenant_hosts WHERE tenant_id = ? AND kind = 'custom' AND status = 'active' LIMIT 1")
            .bind(tenantId)
            .first()
        : null,
    ]);
    return { ...facts, customDomain: Boolean(custom) };
  } catch (error) {
    console.error("setup-checklist-unreadable", error);
    return null;
  }
}
