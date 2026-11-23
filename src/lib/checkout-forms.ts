/**
 * Which checkout forms a product can be sold through (owner, 2026-11-23:
 * "produk digital hanya 1 form, atau produk fisik 3 jenis form hybrid,
 * middle, full"). One list for every admin screen that offers the choice:
 * the landing page editor and the product Embed dialog.
 *
 * The store enforces the same rule on its side: GeoIpResolvedForm and the
 * standalone form pages render the digital checkout for a digital product
 * whatever mode a page or a pasted snippet names. This list keeps the admin
 * from offering a choice the store would ignore.
 */
export type PhysicalFormMode = "hybrid" | "middle" | "full";
export type ProductKind = "physical" | "digital";

export const PHYSICAL_FORM_MODES: ReadonlyArray<{ value: PhysicalFormMode; label: string; hint: string; path: string }> = [
  { value: "hybrid", label: "Hybrid (otomatis)", hint: "Ringkas di provinsi COD, lengkap di provinsi tanpa COD (geo-IP).", path: "/hybrid-form" },
  { value: "middle", label: "Middle (ringkas)", hint: "Nama, WhatsApp, alamat; kecamatan dari geo-IP. Untuk provinsi COD.", path: "/middle-form" },
  { value: "full", label: "Full (lengkap)", hint: "Alamat lengkap sampai kecamatan dan pilihan kurir.", path: "/full-form" },
];

export const DIGITAL_FORM = {
  label: "Form digital (terkunci)",
  hint: "Produk digital selalu memakai form digital: nama, WhatsApp, email opsional, bayar online (QRIS/VA). Tanpa alamat dan tanpa COD.",
} as const;

export const productKind = (type: string | null | undefined): ProductKind => (type === "digital" ? "digital" : "physical");

/**
 * The mode a link or snippet carries. A digital product's links say `hybrid`:
 * the one value every form route accepts, and the store answers it with the
 * digital checkout. A physical product keeps the mode the seller picked.
 */
export function effectiveFormMode(kind: ProductKind, picked: PhysicalFormMode): PhysicalFormMode {
  return kind === "digital" ? "hybrid" : picked;
}

export const physicalFormMode = (value: string | null | undefined) =>
  PHYSICAL_FORM_MODES.find((mode) => mode.value === value) ?? PHYSICAL_FORM_MODES[0];
