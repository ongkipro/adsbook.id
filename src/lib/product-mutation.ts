import { getPublicProductValidationError } from "./catalog-data.ts";

const MAX_VARIANTS = 200;
export function createCatalogProductId() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return 10_000 + (values[0] % 90_000);
}

export type ProductMutationPayload = {
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  category?: unknown;
  brand?: unknown;
  description?: unknown;
  google_category_id?: unknown;
  google_category_path?: unknown;
  is_active?: unknown;
  image_url?: unknown;
  variants?: unknown;
  /** DIGITAL-PRODUCTS-SPEC §2.2: 'physical' (default) or 'digital'. */
  product_type?: unknown;
  digital_access_url?: unknown;
  digital_access_note?: unknown;
};

export type ProductType = "physical" | "digital";
export const DIGITAL_ACCESS_NOTE_MAX = 500;
export const DIGITAL_ACCESS_URL_MAX = 2000;

/**
 * The paid buyer's access link (§6.3): an absolute `https://` URL and nothing
 * else — never `http:`, `javascript:`, `data:` or a relative path, which a
 * buyer's browser would open from the store's own page. No credentials in it,
 * no whitespace or control characters. Null when it is not one.
 */
export function parseDigitalAccessUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > DIGITAL_ACCESS_URL_MAX || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.toString();
}

/**
 * Which product types a store in this catalog mode may save (§4.2): a digital
 * store digital ones, a physical store physical ones, a hybrid store either.
 * A product keeps its own type after the store's mode moves (§8.6), so editing
 * an older product never forces it to change.
 */
export function productTypeAllowed(mode: string | null | undefined, type: ProductType, storedType?: ProductType | null): boolean {
  if (storedType && storedType === type) return true;
  if (mode === "digital") return type === "digital";
  if (mode === "physical") return type === "physical";
  return true;
}

export type ProductStatusTogglePayload = {
  id: number;
  is_active: boolean;
};

type ProductStatusToggleParseResult =
  | { value: ProductStatusTogglePayload }
  | { error: string };

export function parseProductStatusTogglePayload(
  input: unknown,
): ProductStatusToggleParseResult | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  const isStatusOnlyPayload =
    Object.hasOwn(record, "is_active") &&
    keys.every((key) => key === "id" || key === "is_active");
  if (!isStatusOnlyPayload) return null;

  const productId =
    typeof record.id === "number"
      ? record.id
      : typeof record.id === "string" && /^\d+$/.test(record.id)
        ? Number(record.id)
        : Number.NaN;
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return { error: "ID produk tidak valid." };
  }
  if (typeof record.is_active !== "boolean") {
    return { error: "Status produk harus berupa boolean." };
  }

  return {
    value: {
      id: productId,
      is_active: record.is_active,
    },
  };
}

export async function updateProductActiveStatus(
  database: D1Database,
  payload: ProductStatusTogglePayload,
): Promise<boolean> {
  const result = await database
    .prepare("UPDATE products SET is_active = ? WHERE id = ?")
    .bind(payload.is_active ? 1 : 0, payload.id)
    .run();
  return Boolean(result.meta.changes);
}

type ParsedVariant = {
  id?: number;
  sku: string;
  title: string;
  price: number;
  compare_price: number | null;
  /** Null only for an existing variant saved without a weight: keep its stored one. */
  weight_grams: number | null;
  stock: number;
};

type ParsedProduct = {
  id?: number;
  title: string;
  slug: string;
  category: string;
  /** Undefined when the request did not send it: an update keeps the stored value. */
  brand?: string | null;
  description?: string | null;
  /** Google product taxonomy id and path; undefined keeps the stored pair. */
  google_category_id?: number | null;
  google_category_path?: string | null;
  image_url: string | null;
  is_active: boolean;
  product_type: ProductType;
  /** Null for a physical product; a digital one always has its https link. */
  digital_access_url: string | null;
  digital_access_note: string | null;
  variants: ParsedVariant[];
};

type ParseResult<T> = { value: T } | { error: string; status?: number };

// Mengantar's per-service weight limits: regular 50 kg, cargo 100 kg, lite
// 0.5 kg. Source: the local notes in ~/Projects/mengantar-documentation,
// docs/02-couriers-and-rules.md §3.1 (and the glossary in docs/07-reference.md),
// which say they summarise the official Mengantar API docs plus live
// observation; not re-checked against app.mengantar.com/docs here.
// This CMS never sends `cargo: true`, so one unit heavier than the regular
// limit can never be dispatched.
// lazy: the cap is per unit, not per parcel — quantity × weight above 50 kg
// passes here and is left to the quote/Mengantar to refuse. Upgrade path: check
// the line's total weight against the service limit at quote and conversion.
export const MAX_VARIANT_WEIGHT_GRAMS = 50_000;

function isMissing(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function capitalizeTitle(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseInteger(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numberValue) ? numberValue : null;
}

export function parseProductMutationPayload(
  body: ProductMutationPayload | null,
  requireId: true,
  storedImageUrl?: string | null,
): ParseResult<ParsedProduct & { id: number }>;
export function parseProductMutationPayload(
  body: ProductMutationPayload | null,
  requireId: false,
  storedImageUrl?: string | null,
): ParseResult<ParsedProduct>;
export function parseProductMutationPayload(
  body: ProductMutationPayload | null,
  requireId: boolean,
  storedImageUrl?: string | null,
): ParseResult<ParsedProduct> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Payload tidak valid." };
  }

  const rawTitle = clean(body.title, 160);
  const title = capitalizeTitle(rawTitle);
  const slug = normalizeSlug(clean(body.slug, 200));
  const category = clean(body.category, 120) || "Umum";
  // `products.brand` / `products.description` (0051) feed Google and Meta and
  // the product page. Google caps brand at 70 and description at 5000; over a
  // cap the item is disapproved, so the cap is applied here, at the boundary.
  const brand = body.brand === undefined ? undefined : clean(body.brand, 70) || null;
  const description =
    body.description === undefined
      ? undefined
      : (typeof body.description === "string"
          ? body.description.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000)
          : "") || null;
  // A Google taxonomy id with its path, or null to clear both. The id is not
  // checked against the list here: the taxonomy lives in a static asset the
  // Worker does not load, and the field is admin-only.
  // lazy: an id outside Google's list reaches the feed and Merchant Center
  // flags it. Upgrade path: validate against the asset via the ASSETS binding.
  let googleCategoryId: number | null | undefined;
  let googleCategoryPath: string | null | undefined;
  if (body.google_category_id !== undefined) {
    if (body.google_category_id === null || body.google_category_id === "") {
      googleCategoryId = null;
      googleCategoryPath = null;
    } else {
      const id = parseInteger(body.google_category_id);
      const path = clean(body.google_category_path, 750);
      if (id === null || id <= 0 || !path) {
        return { error: "Kategori Google tidak valid. Pilih ulang dari daftar." };
      }
      googleCategoryId = id;
      googleCategoryPath = path;
    }
  }
  const imageUrl = clean(body.image_url, 500);
  // A value the row already holds is never re-judged: saving an edit (removing
  // a variant, say) must not fail on an image address it did not change.
  if (
    imageUrl &&
    imageUrl !== (storedImageUrl ?? "").trim() &&
    !imageUrl.startsWith("/assets/uploads/") &&
    !imageUrl.startsWith("/images/")
  ) {
    return {
      error:
        "Alamat gambar produk tidak dikenali. Unggah ulang foto produk lewat tombol Ganti foto.",
    };
  }
  const isActive = typeof body.is_active === "boolean" ? body.is_active : true;
  const parsedProductId =
    body.id === undefined ? undefined : parseInteger(body.id);

  if (
    parsedProductId !== undefined &&
    (parsedProductId === null || parsedProductId <= 0)
  ) {
    return { error: "ID produk tidak valid." };
  }
  if (requireId && parsedProductId === undefined) {
    return { error: "ID produk wajib valid untuk update." };
  }
  if (!requireId && parsedProductId !== undefined) {
    return { error: "ID produk dibuat otomatis oleh sistem." };
  }
  const productId = parsedProductId ?? undefined;
  if (!title || !slug) {
    return { error: "Judul dan slug produk wajib diisi." };
  }
  if (!Array.isArray(body.variants) || body.variants.length === 0) {
    return { error: "Produk minimal harus memiliki 1 varian." };
  }
  if (body.variants.length > MAX_VARIANTS) {
    return { error: `Produk maksimal memiliki ${MAX_VARIANTS} varian.` };
  }

  // §2.2/§6.3: an unknown type is refused, never guessed; a digital product
  // needs its https access link and ships nothing, so it has no weight.
  if (body.product_type !== undefined && body.product_type !== "physical" && body.product_type !== "digital") {
    return { error: "Jenis produk tidak dikenal." };
  }
  const productType: ProductType = body.product_type === "digital" ? "digital" : "physical";
  let digitalAccessUrl: string | null = null;
  let digitalAccessNote: string | null = null;
  if (productType === "digital") {
    digitalAccessUrl = parseDigitalAccessUrl(body.digital_access_url);
    if (!digitalAccessUrl) {
      return { error: "Link akses produk digital wajib berupa alamat https:// yang valid.", status: 422 };
    }
    const note = typeof body.digital_access_note === "string" ? body.digital_access_note.replace(/\r\n?/g, "\n").trim() : "";
    if (note.length > DIGITAL_ACCESS_NOTE_MAX) {
      return { error: `Instruksi akses maksimal ${DIGITAL_ACCESS_NOTE_MAX} karakter.` };
    }
    digitalAccessNote = note || null;
  }

  const variants: ParsedVariant[] = [];
  const skuSet = new Set<string>();
  const variantIdSet = new Set<number>();

  for (const rawVariant of body.variants) {
    if (
      !rawVariant ||
      typeof rawVariant !== "object" ||
      Array.isArray(rawVariant)
    ) {
      return { error: "Data varian tidak valid." };
    }

    const variantId =
      rawVariant.id === undefined ? undefined : parseInteger(rawVariant.id);
    if (!requireId && variantId !== undefined) {
      return { error: "ID varian dibuat otomatis oleh D1." };
    }
    const sku = clean(rawVariant.sku, 80).toUpperCase();
    const rawTitleStr = typeof rawVariant.title === "string" ? rawVariant.title.trim() : "";
    if (rawTitleStr.length > 15) {
      return { error: `Nama varian "${rawTitleStr}" melebihi batas maksimal 15 karakter.` };
    }
    const variantTitle = clean(rawVariant.title, 15);
    const price = parseInteger(rawVariant.price);
    const comparePrice =
      rawVariant.compare_price === undefined ||
      rawVariant.compare_price === null ||
      rawVariant.compare_price === ""
        ? null
        : parseInteger(rawVariant.compare_price);
    // Missing and 1000 are different (PRD A41): a missing weight is never
    // invented. A new variant must state it; an existing one keeps its own.
    const weightMissing = productType === "physical" && isMissing(rawVariant.weight_grams);
    const weightGrams = productType === "digital"
      ? 0
      : weightMissing
        ? null
        : parseInteger(rawVariant.weight_grams);
    const stock = parseInteger(rawVariant.stock);

    if (variantId !== undefined && (!variantId || variantId <= 0)) {
      return { error: "ID varian tidak valid." };
    }
    if (!sku || !variantTitle) {
      return { error: "SKU dan judul varian wajib diisi." };
    }
    if (skuSet.has(sku)) {
      return { error: `SKU ${sku} duplikat dalam payload.` };
    }
    if (variantId !== undefined && variantIdSet.has(variantId)) {
      return { error: "ID varian duplikat dalam payload." };
    }
    if (!price || price <= 0) {
      return { error: `Harga varian ${sku} harus integer positif.` };
    }
    if (productType === "digital") {
      // Nothing ships: the weight is 0 whatever the request said.
    } else if (weightMissing) {
      if (variantId === undefined) {
        return { error: `Berat varian ${sku} wajib diisi (gram).`, status: 422 };
      }
    } else if (!weightGrams || weightGrams <= 0) {
      return { error: `Berat varian ${sku} harus integer positif.` };
    } else if (weightGrams > MAX_VARIANT_WEIGHT_GRAMS) {
      return {
        error: `Berat varian ${sku} maksimal 50.000 gram (batas layanan reguler Mengantar).`,
      };
    }
    if (comparePrice !== null && comparePrice < 0) {
      return { error: `Harga coret varian ${sku} harus nol atau lebih.` };
    }
    if (comparePrice !== null && comparePrice < price) {
      return {
        error: `Harga coret varian ${sku} tidak boleh lebih kecil dari harga jual.`,
      };
    }

    skuSet.add(sku);
    variants.push({
      id: variantId,
      sku,
      title: variantTitle,
      price,
      compare_price: comparePrice,
      weight_grams: weightGrams,
      // Retained as bookkeeping only. Nothing gates a sale on it since
      // ADR-023, so an absent or negative figure is stored as zero rather
      // than refused — a save must not fail over a number nobody reads.
      stock: stock !== null && stock > 0 ? stock : 0,
    });
  }

  const value = {
    id: productId,
    title,
    slug,
    category,
    ...(brand !== undefined ? { brand } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(googleCategoryId !== undefined
      ? { google_category_id: googleCategoryId, google_category_path: googleCategoryPath ?? null }
      : {}),
    image_url: imageUrl || null,
    is_active: isActive,
    product_type: productType,
    digital_access_url: digitalAccessUrl,
    digital_access_note: digitalAccessNote,
    variants,
  };
  if (isActive) {
    const publicationError = getPublicProductValidationError(value, variants);
    if (publicationError) return { error: publicationError };
  }

  return { value };
}

export type ProductDeletionResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "referenced" };

export async function deleteCatalogProduct(
  database: D1Database,
  productId: number,
): Promise<ProductDeletionResult> {
  const product = await database
    .prepare("SELECT id FROM products WHERE id = ? LIMIT 1")
    .bind(productId)
    .first();
  if (!product) return { status: "not_found" };

  const results = await database.batch([
    database
      .prepare(
        `
        DELETE FROM product_variants
        WHERE product_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM order_items oi
            INNER JOIN product_variants referenced
              ON referenced.id = oi.variant_id
            WHERE referenced.product_id = ?
          )
      `,
      )
      .bind(productId, productId),
    database
      .prepare(
        `
        DELETE FROM products
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM product_variants WHERE product_id = ?
          )
      `,
      )
      .bind(productId, productId),
    database
      .prepare(
        `DELETE FROM storefront_content
         WHERE content_key = ?
           AND NOT EXISTS (SELECT 1 FROM products WHERE id = ?)`,
      )
      .bind(`product:${productId}`, productId),
  ]);
  return Number(results[1]?.meta?.changes || 0) > 0
    ? { status: "deleted" }
    : { status: "referenced" };
}
