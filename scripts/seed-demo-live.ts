/**
 * `npm run seed:demo-live` — fill the production demo store (`demo.adsbook.my.id`,
 * PR-26) with the local dummy catalogue, through the store's own admin API, as
 * a browser would. Operator-run, never part of a deploy; nothing in `src/`
 * imports it.
 *
 * It runs BEFORE the store is flagged `is_demo` (a demo store refuses every
 * write); the flag is a separate, approved PLATFORM_DB write. Safe by
 * construction:
 *   - the host must be exactly `demo.<seller zone>`; no other store is reachable;
 *   - it saves store identity, a public WhatsApp/email and products only — never
 *     a provider key (Mengantar, AutoLaris, Meta, Google, Kelola), never a
 *     warehouse, never an order;
 *   - the owner password comes from the environment (`secrets-env run`), never
 *     an argument, and is never printed;
 *   - re-running skips products whose slug exists.
 *
 *   --host=demo.adsbook.my.id   (default)
 *   --images=<dir>              <slug>.webp and <slug>-sm.webp per product
 *                               (default ~/Documents/work/assets/dummy-products/webp);
 *                               keep the folder outside the repository.
 *   --full-demo                 also configure Mengantar key + primary warehouse
 *                               from env, seed flagship landing pages, and fill
 *                               realistic showcase orders & leads (external
 *                               shipping channel only — zero live Mengantar
 *                               dispatches and zero ad pixels).
 *
 * Env: ADSBOOK_DEMO_OWNER_PASSWORD (required), ADSBOOK_DEMO_OWNER_EMAIL (default demo@adsbook.id).
 *      For --full-demo: DEMO_COURIER_API_KEY, DEMO_ORIGIN_AREA_ID, DEMO_PICKUP_ADDRESS_ID.
 */
import { existsSync, readFileSync } from "node:fs";
import { prepareImage } from "./prepare-image.ts";
import { homedir } from "node:os";

const arg = (name: string) => process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const fullDemo = process.argv.slice(2).includes("--full-demo");
const host = (arg("host") || "demo.adsbook.my.id").toLowerCase();
if (!/^demo\.[a-z0-9.-]+$/.test(host)) {
  console.error(`[seed:demo-live] refusing ${host}: only the demo store (demo.<seller zone>) may be filled.`);
  process.exit(1);
}
const base = `https://${host}`;
const imageDir = (arg("images") || `${homedir()}/Documents/work/assets/dummy-products/webp`).replace(/\/$/, "");
const email = process.env.ADSBOOK_DEMO_OWNER_EMAIL || "demo@adsbook.id";
const password = process.env.ADSBOOK_DEMO_OWNER_PASSWORD || "";
if (!password) {
  console.error("[seed:demo-live] ADSBOOK_DEMO_OWNER_PASSWORD is not set (run through secrets-env).");
  process.exit(1);
}

let cookie = "";
async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", base);
  headers.set("Sec-Fetch-Site", "same-origin");
  const existingCookie = headers.get("Cookie");
  if (cookie) headers.set("Cookie", existingCookie ? `${cookie}; ${existingCookie}` : cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${base}${path}`, { ...init, headers, body, redirect: "manual" });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text.slice(0, 200);
  }
  return { status: response.status, payload, headers: response.headers };
}
function ok(step: string, result: { status: number; payload: any }) {
  if (result.status >= 400 || result.payload?.success === false) {
    const detail = typeof result.payload === "string" ? result.payload : JSON.stringify(result.payload)?.slice(0, 300);
    throw new Error(`${step} → HTTP ${result.status}: ${detail}`);
  }
  return result.payload;
}

const STORE = {
  store_name: "Toko Contoh adsbook.id",
  store_tagline: "Contoh toko COD siap iklan",
  store_description: "Toko contoh untuk melihat tampilan adsbook.id: katalog, halaman produk, dan form pesanan COD. Pemesanan tidak aktif di toko ini.",
  support_email: "halo@adsbook.id",
  business_address: "Jakarta, Indonesia",
  storefront_template: "compact-market",
  theme_color: "#111111",
  locale: "id-ID",
};

type Variant = { sku: string; title: string; price: number; compare_price: number | null; weight_grams: number };
const PRODUCTS: { title: string; slug: string; category: string; brand: string; description: string; variants: Variant[] }[] = [
  {
    title: "Kaos Katun Combed 30s",
    slug: "kaos-katun-dummy",
    category: "Pakaian",
    brand: "Contoh",
    description: "Kaos katun combed 30s yang adem dan tidak mudah melar. Jahitan rantai di bahu, cocok untuk harian.\n\n- Bahan katun combed 30s\n- Ukuran S, M, L\n- Cuci dengan air dingin",
    variants: [
      { sku: "DEMO-KAOS-S", title: "S", price: 79000, compare_price: 99000, weight_grams: 250 },
      { sku: "DEMO-KAOS-M", title: "M", price: 79000, compare_price: 99000, weight_grams: 260 },
      { sku: "DEMO-KAOS-L", title: "L", price: 85000, compare_price: 105000, weight_grams: 280 },
    ],
  },
  {
    title: "Madu Hutan Murni",
    slug: "madu-hutan-dummy",
    category: "Makanan",
    brand: "Contoh",
    description: "Madu hutan murni dari lebah liar, rasa manis dengan sedikit pahit khas madu hutan.\n\n- Tanpa campuran gula\n- Botol kaca 250 ml dan 500 ml",
    variants: [
      { sku: "DEMO-MADU-250", title: "250 ml", price: 65000, compare_price: null, weight_grams: 400 },
      { sku: "DEMO-MADU-500", title: "500 ml", price: 120000, compare_price: 135000, weight_grams: 750 },
    ],
  },
  {
    title: "Tas Selempang Kanvas",
    slug: "tas-selempang-dummy",
    category: "Aksesoris",
    brand: "Contoh",
    description: "Tas selempang kanvas tebal dengan tali yang bisa diatur. Muat ponsel, dompet, dan botol minum kecil.",
    variants: [{ sku: "DEMO-TAS-HITAM", title: "Hitam", price: 149000, compare_price: 199000, weight_grams: 600 }],
  },
  {
    title: "Serum Wajah Niacinamide",
    slug: "serum-wajah-dummy",
    category: "Kecantikan",
    brand: "Contoh",
    description: "Serum ringan untuk pemakaian pagi dan malam. Tekstur cair, cepat meresap.\n\n- Botol pipet 20 ml dan 50 ml",
    variants: [
      { sku: "DEMO-SERUM-20", title: "20 ml", price: 89000, compare_price: 119000, weight_grams: 150 },
      { sku: "DEMO-SERUM-50", title: "50 ml", price: 179000, compare_price: null, weight_grams: 220 },
    ],
  },
  {
    title: "Lampu Dinding Tenaga Surya",
    slug: "lampu-dinding-solar-dummy",
    category: "Rumah Tangga",
    brand: "Contoh",
    description: "Lampu dinding tenaga surya dengan sensor gerak. Menyala otomatis saat gelap, tanpa kabel listrik.",
    variants: [
      { sku: "DEMO-SOLAR-1", title: "1 pcs", price: 69000, compare_price: 89000, weight_grams: 350 },
      { sku: "DEMO-SOLAR-2", title: "2 pcs", price: 129000, compare_price: 178000, weight_grams: 700 },
    ],
  },
  {
    title: "Holder HP Motor",
    slug: "holder-hp-motor-dummy",
    category: "Otomotif",
    brand: "Contoh",
    description: "Holder HP untuk setang motor, penjepit kuat dan bisa diputar 360°. Cocok untuk ponsel 4,7–6,8 inci.",
    variants: [{ sku: "DEMO-HOLDER-1", title: "Hitam", price: 55000, compare_price: 75000, weight_grams: 300 }],
  },
  {
    title: "Senter LED Mini",
    slug: "senter-led-mini-dummy",
    category: "Perlengkapan",
    brand: "Contoh",
    description: "Senter LED kecil yang terang, muat di saku. Baterai isi ulang lewat USB.",
    variants: [{ sku: "DEMO-SENTER-1", title: "Default", price: 45000, compare_price: 60000, weight_grams: 200 }],
  },
  {
    title: "Lem Serbaguna",
    slug: "lem-serbaguna-dummy",
    category: "Perkakas",
    brand: "Contoh",
    description: "Lem serbaguna untuk kayu, plastik, keramik, dan logam. Kering dalam hitungan menit.",
    variants: [
      { sku: "DEMO-LEM-50", title: "50 g", price: 35000, compare_price: null, weight_grams: 120 },
      { sku: "DEMO-LEM-100", title: "100 g", price: 59000, compare_price: 70000, weight_grams: 220 },
    ],
  },
  {
    title: "Pembersih Kerak Panci",
    slug: "pembersih-kerak-panci-dummy",
    category: "Rumah Tangga",
    brand: "Contoh",
    description: "Cairan pembersih kerak dan noda gosong pada panci dan wajan. Cukup diamkan lalu gosok.",
    variants: [{ sku: "DEMO-KERAK-1", title: "250 ml", price: 49000, compare_price: 65000, weight_grams: 350 }],
  },
  {
    title: "Pembersih Saluran Air",
    slug: "pembersih-saluran-dummy",
    category: "Rumah Tangga",
    brand: "Contoh",
    description: "Pembersih saluran air yang melarutkan lemak dan rambut penyebab mampet. Aman untuk pipa PVC.",
    variants: [
      { sku: "DEMO-SALURAN-1", title: "1 botol", price: 39000, compare_price: 55000, weight_grams: 500 },
      { sku: "DEMO-SALURAN-3", title: "3 botol", price: 99000, compare_price: 165000, weight_grams: 1500 },
    ],
  },
];

function image(slug: string, suffix = "") {
  const path = `${imageDir}/${slug}${suffix}.webp`;
  return existsSync(path) ? new File([readFileSync(path)], `${slug}${suffix}.webp`, { type: "image/webp" }) : null;
}

async function main() {
  console.log(`[seed:demo-live] ${base}`);
  const login = await call("/hello", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password }).toString(),
  });
  cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).find((value) => value.startsWith("__Host-adsbook_session=")) ?? "";
  if (!cookie) throw new Error(`sign-in as ${email} failed (HTTP ${login.status}); is the store already flagged is_demo, or is the password wrong?`);
  console.log(`[seed:demo-live] signed in as ${email}`);

  ok("save-store", await call("/api/admin/settings", { method: "PUT", json: { action: "save-store", ...STORE } }));
  console.log("[seed:demo-live] store identity saved");

  const listed = ok("products list", await call("/api/admin/products"));
  const rows: any[] = listed?.data?.products ?? listed?.data ?? listed?.products ?? [];
  const existing = new Set(rows.map((row) => row.slug));
  for (const product of PRODUCTS) {
    if (existing.has(product.slug)) {
      console.log(`[seed:demo-live] ${product.slug} exists — skipping`);
      continue;
    }
    const full = image(product.slug);
    if (!full) throw new Error(`missing image ${imageDir}/${product.slug}.webp`);
    // The admin's rules (scripts/prepare-image.ts): WebP 480 px + JPEG 1024 px for the feeds.
    const prepared = await prepareImage(new Uint8Array(await full.arrayBuffer()), product.slug, { feed: true });
    const form = new FormData();
    form.set("file", prepared.display);
    const upload = ok(`upload ${product.slug}`, await call("/api/admin/upload-r2", { method: "POST", body: form }));
    const imageUrl = upload?.data?.url ?? upload?.url;
    const fileName = upload?.data?.fileName ?? upload?.fileName;
    if (fileName && prepared.feed) {
      const feedForm = new FormData();
      feedForm.set("file", prepared.feed);
      feedForm.set("variant", "feed");
      feedForm.set("variant_of", fileName);
      const feedResult = await call("/api/admin/upload-r2", { method: "POST", body: feedForm });
      if (feedResult.status >= 400) console.warn(`[seed:demo-live] catalog copy for ${product.slug} → HTTP ${feedResult.status}`);
    }
    ok(
      `create ${product.slug}`,
      await call("/api/admin/products", {
        method: "POST",
        json: { ...product, image_url: imageUrl, is_active: true, variants: product.variants.map((variant) => ({ ...variant, stock: 100 })) },
      }),
    );
    console.log(`[seed:demo-live] ${product.slug} created`);
  }

  if (fullDemo) {
    await seedFullShowcase();
  }

  await call("/api/admin/logout", { method: "POST" });
  console.log("[seed:demo-live] done. Next: flag the store is_demo (approved PLATFORM_DB write).");
}

type DemoProductRow = {
  id: number;
  slug: string;
  title: string;
  image_url?: string;
  product_type?: string;
  is_active?: number | boolean;
  variants?: Array<{ id: number; title: string; price: number }>;
};

async function seedFullShowcase() {
  // 1. Read current settings & warehouses FIRST.
  // CRITICAL: create the primary warehouse BEFORE saving mengantar_api_key so
  // pickupRegistrar is null and addWarehouse persists pickup_address_id directly
  // in D1 with ZERO POST /address mutation against the provider account.
  const mengantarKey = (process.env.DEMO_COURIER_API_KEY || "").trim();
  const originAreaId = (process.env.DEMO_ORIGIN_AREA_ID || "").trim();
  const pickupAddressId = (process.env.DEMO_PICKUP_ADDRESS_ID || "").trim();
  const settingsRes = ok("read settings", await call("/api/admin/settings"));
  const mengantarAlreadyConfigured = Boolean(settingsRes?.data?.credentials?.mengantar?.configured);

  const whRes = ok("list warehouses", await call("/api/admin/warehouses"));
  const warehouses: any[] = whRes?.data ?? [];
  if (warehouses.length === 0 && originAreaId) {
    if (mengantarAlreadyConfigured) {
      throw new Error(
        "Refusing to POST /api/admin/warehouses while mengantar_api_key is already configured (would call Mengantar POST /address). Clear the key or add the warehouse first.",
      );
    }
    ok(
      "create primary warehouse",
      await call("/api/admin/warehouses", {
        method: "POST",
        json: {
          name: "Gudang Utama Jakarta",
          contact_name: "Tim Gudang Contoh",
          contact_phone: "081234567890",
          origin_area_id: originAreaId,
          origin_label: "Gambir, Jakarta Pusat, DKI Jakarta",
          pickup_address_id: pickupAddressId || undefined,
          address: "Jl. Merdeka Barat No. 10, Gambir, Jakarta Pusat",
          city: "Jakarta Pusat",
          province: "DKI Jakarta",
        },
      }),
    );
    console.log("[seed:demo-live] primary warehouse created (local D1 only, zero provider write)");
  }

  // 2. Configure Mengantar API key from operator-supplied demo env (sealed via ADR-040, never echoed).
  if (mengantarKey && !mengantarAlreadyConfigured) {
    ok(
      "save-integrations (mengantar)",
      await call("/api/admin/settings", {
        method: "PUT",
        json: { action: "save-integrations", integrations: { mengantar_api_key: mengantarKey } },
      }),
    );
    console.log("[seed:demo-live] Mengantar API key configured (sealed)");
  }

  const bankRes = ok("list seller bank accounts", await call("/api/admin/seller-bank-accounts"));
  const activeBankAccount = ((bankRes?.data ?? []) as Array<{ id: number; is_active?: number }>).find(
    (row) => Number(row.is_active ?? 1) === 1,
  );
  const sellerBankAccountId = activeBankAccount ? Number(activeBankAccount.id) : undefined;

  // 3. Seed 3 flagship Landing Pages linked to active physical demo products.
  const prodRes = ok("reload products", await call("/api/admin/products"));
  const allProducts: DemoProductRow[] = prodRes?.data?.products ?? prodRes?.data ?? [];
  const bySlug = new Map(allProducts.map((p) => [p.slug, p]));
  const lpRes = ok("list landing pages", await call("/api/admin/landing-pages"));
  const existingLps = new Set(((lpRes?.data ?? []) as Array<{ slug?: string }>).map((lp) => lp.slug));

  const flagshipPages = [
    {
      slug: "kaos-katun-promo",
      productSlug: "kaos-katun-dummy",
      title: "Promo Kaos Katun Combed 30s — Adem Dipakai Seharian",
      meta_title: "Kaos Katun Combed 30s — Bayar di Tempat (COD)",
      meta_description: "Kaos katun combed 30s lembut, jahitan rantai rapi, tersedia S/M/L. Bisa COD seluruh Jawa.",
      headline: "Kaos Katun Combed 30s — Adem, Rapi, Tidak Mudah Melar",
      bullets: [
        "100% katun combed 30s asli, nyaman di cuaca tropis",
        "Jahitan rantai kuat di bahu, tetap rapi setelah dicuci",
        "Bisa bayar di tempat (COD) atau transfer langsung",
      ],
    },
    {
      slug: "serum-niacinamide-glow",
      productSlug: "serum-wajah-dummy",
      title: "Serum Wajah Niacinamide — Ringan & Cepat Meresap",
      meta_title: "Serum Wajah Niacinamide 20ml & 50ml — Bisa COD",
      meta_description: "Serum ringan untuk pemakaian pagi dan malam. Tekstur cair, cepat meresap, pengiriman aman.",
      headline: "Kulit Tampak Cerah Merata Tanpa Rasa Lengket",
      bullets: [
        "Tekstur cair ringan, cepat meresap untuk pemakaian pagi & malam",
        "Tersedia kemasan 20 ml (coba dulu) dan 50 ml (hemat)",
        "Pengemasan bubble wrap tebal dan bisa COD",
      ],
    },
    {
      slug: "madu-hutan-asli",
      productSlug: "madu-hutan-dummy",
      title: "Madu Hutan Murni — Dipanen dari Lebah Liar Tanpa Gula Tambahan",
      meta_title: "Madu Hutan Murni 250ml & 500ml — Pengiriman Aman",
      meta_description: "Madu hutan murni rasa manis dengan sedikit pahit alami. Tersedia botol kaca 250 ml dan 500 ml.",
      headline: "Madu Hutan Murni Asli — Jaga Stamina Keluarga Setiap Hari",
      bullets: [
        "100% madu lebah liar tanpa campuran gula atau pengawet",
        "Dikemas dalam botol kaca higienis ukuran 250 ml & 500 ml",
        "Garansi kirim aman & tersedia pembayaran COD",
      ],
    },
  ];

  for (const page of flagshipPages) {
    if (existingLps.has(page.slug)) {
      console.log(`[seed:demo-live] landing page /${page.slug} exists — skipping`);
      continue;
    }
    const product = bySlug.get(page.productSlug);
    if (!product) continue;
    ok(
      `create landing /${page.slug}`,
      await call("/api/admin/landing-pages", {
        method: "POST",
        json: {
          slug: page.slug,
          title: page.title,
          product_id: String(product.id),
          is_active: 1,
          meta_title: page.meta_title,
          meta_description: page.meta_description,
          sections: [
            { type: "headline", content_config: { text: page.headline, align: "center", size: "large" } },
            ...(product.image_url ? [{ type: "image", content_config: { src: product.image_url, alt: product.title } }] : []),
            { type: "bullet_list", content_config: { items: page.bullets } },
            {
              type: "form",
              form_config: {
                mode: "hybrid",
                section_title: "Pesan Sekarang — Bisa Bayar di Tempat (COD)",
                button_text: "Kirim Pesanan",
              },
            },
          ],
        },
      }),
    );
    console.log(`[seed:demo-live] landing page /${page.slug} created`);
  }

  // 4. Seed realistic showcase orders (external shipping channel only: zero live Mengantar dispatches!)
  const ordersRes = ok("list orders", await call("/api/admin/orders?limit=20"));
  const existingOrders: any[] = Array.isArray(ordersRes?.data) ? ordersRes.data : (ordersRes?.data?.orders ?? []);
  if (existingOrders.length < 8) {
    const physicalProducts = allProducts.filter((p) => p.product_type !== "digital" && p.variants?.length);
    const locationsCache = new Map<string, { id: string; district: string; city: string; province: string }>();
    const resolveArea = async (keyword: string) => {
      if (locationsCache.has(keyword)) return locationsCache.get(keyword)!;
      const res = ok(`locations ${keyword}`, await call(`/api/locations?search=${encodeURIComponent(keyword)}`));
      const rows: any[] = res?.locations ?? res?.items ?? res?.data ?? [];
      const first = rows.find((row) => String(row?.id ?? row?._id ?? row?.location_id ?? "").trim());
      if (!first) throw new Error(`no location match for ${keyword}`);
      const area = {
        id: String(first.id ?? first._id ?? first.location_id),
        district: String(first.district ?? first.subdistrict ?? keyword),
        city: String(first.city ?? ""),
        province: String(first.province ?? ""),
      };
      locationsCache.set(keyword, area);
      return area;
    };

    const scenarios: Array<{
      name: string;
      phone: string;
      area: string;
      address: string;
      productSlug: string;
      payment: "cod" | "manual_transfer";
      referer: string;
      utm: { utm_source: string; utm_campaign: string; utm_content?: string };
      finalChannel: "mengantar" | "external";
      finalStatus: "pending" | "shipped" | "delivered" | "returned";
      markPaid?: boolean;
      courier?: string;
      cnote?: string;
    }> = [
      {
        name: "Budi Santoso",
        phone: "081231001001",
        area: "Coblong",
        address: "Jl. Dago Asri No. 14, Coblong",
        productSlug: "kaos-katun-dummy",
        payment: "cod",
        referer: `${base}/kaos-katun-promo`,
        utm: { utm_source: "facebook", utm_campaign: "promo_kaos_nov", utm_content: "video_a" },
        finalChannel: "external",
        finalStatus: "delivered",
        courier: "JNE",
        cnote: "DEMO-JNE-1001",
      },
      {
        name: "Siti Rahmawati",
        phone: "081231001002",
        area: "Gubeng",
        address: "Jl. Dharmawangsa No. 28, Gubeng",
        productSlug: "serum-wajah-dummy",
        payment: "manual_transfer",
        referer: `${base}/serum-niacinamide-glow`,
        utm: { utm_source: "instagram", utm_campaign: "serum_glow_asc", utm_content: "carousel_1" },
        finalChannel: "external",
        finalStatus: "delivered",
        markPaid: true,
        courier: "J&T",
        cnote: "DEMO-JT-1002",
      },
      {
        name: "Ahmad Fauzi",
        phone: "081231001003",
        area: "Depok",
        address: "Jl. Kaliurang KM 6 No. 9, Depok",
        productSlug: "madu-hutan-dummy",
        payment: "cod",
        referer: `${base}/madu-hutan-asli`,
        utm: { utm_source: "google", utm_campaign: "search_madu_hutan" },
        finalChannel: "external",
        finalStatus: "delivered",
        courier: "JNE",
        cnote: "DEMO-JNE-1003",
      },
      {
        name: "Dewi Lestari",
        phone: "081231001004",
        area: "Kebayoran Baru",
        address: "Jl. Radio Dalam No. 52, Kebayoran Baru",
        productSlug: "tas-selempang-dummy",
        payment: "manual_transfer",
        referer: `${base}/produk/tas-selempang-dummy`,
        utm: { utm_source: "tiktok", utm_campaign: "vsa_tas_kanvas", utm_content: "hook_2" },
        finalChannel: "external",
        finalStatus: "shipped",
        markPaid: true,
        courier: "SiCepat",
        cnote: "DEMO-SC-1004",
      },
      {
        name: "Rizky Pratama",
        phone: "081231001005",
        area: "Banyumanik",
        address: "Jl. Setiabudi No. 88, Banyumanik",
        productSlug: "lampu-dinding-solar-dummy",
        payment: "cod",
        referer: `${base}/produk/lampu-dinding-solar-dummy`,
        utm: { utm_source: "facebook", utm_campaign: "lampu_solar_cod", utm_content: "demo_video" },
        finalChannel: "external",
        finalStatus: "delivered",
        courier: "J&T",
        cnote: "DEMO-JT-1005",
      },
      {
        name: "Nadia Kusuma",
        phone: "081231001006",
        area: "Bekasi Selatan",
        address: "Jl. Pekayon Jaya No. 19, Bekasi Selatan",
        productSlug: "serum-wajah-dummy",
        payment: "cod",
        referer: `${base}/serum-niacinamide-glow`,
        utm: { utm_source: "tiktok", utm_campaign: "serum_tiktok_live" },
        finalChannel: "external",
        finalStatus: "shipped",
        courier: "JNE",
        cnote: "DEMO-JNE-1006",
      },
      {
        name: "Hendra Wijaya",
        phone: "081231001007",
        area: "Lowokwaru",
        address: "Jl. Soekarno Hatta No. 41, Lowokwaru",
        productSlug: "holder-hp-motor-dummy",
        payment: "cod",
        referer: `${base}/produk/holder-hp-motor-dummy`,
        utm: { utm_source: "facebook", utm_campaign: "otomotif_cod" },
        finalChannel: "external",
        finalStatus: "returned",
        courier: "J&T",
        cnote: "DEMO-JT-1007",
      },
      {
        name: "Putri Anggraini",
        phone: "081231001008",
        area: "Tangerang",
        address: "Jl. Kisamaun No. 7, Tangerang",
        productSlug: "kaos-katun-dummy",
        payment: "cod",
        referer: `${base}/kaos-katun-promo`,
        utm: { utm_source: "facebook", utm_campaign: "promo_kaos_nov", utm_content: "video_b" },
        finalChannel: "mengantar",
        finalStatus: "pending",
      },
    ];

    for (let i = 0; i < scenarios.length; i += 1) {
      const s = scenarios[i];
      const product = bySlug.get(s.productSlug) ?? physicalProducts[i % physicalProducts.length];
      const variant = product?.variants?.[0];
      if (!product || !variant) continue;
      const area = await resolveArea(s.area);
      const quote = ok(
        `shipping-options ${s.area}`,
        await call(
          `/api/shipping-options?${new URLSearchParams({
            location_id: area.id,
            variant_unique_id: String(variant.id),
            payment_method: s.payment,
            city: area.city,
          })}`,
        ),
      );
      const rates: any[] = quote.rates ?? [];
      const eligible = rates
        .map((rate, position) => ({ rate, position }))
        .filter(({ rate }) => !rate.unsupported && (s.payment !== "cod" || !rate.unsupported_cod));
      if (!eligible.length) {
        console.warn(`[seed:demo-live] no eligible rate for ${s.area} (${s.payment}) — skipping`);
        continue;
      }
      const chosen = eligible[0];
      const clickCookie = `adsbook_click_ids=${encodeURIComponent(JSON.stringify(s.utm))}`;
      const submitted = ok(
        `submit-order demo #${i + 1}`,
        await call("/api/submit-order", {
          method: "POST",
          headers: { Referer: s.referer, Cookie: clickCookie },
          json: {
            submit_token: `demo-showcase-${Date.now()}-${i}`,
            website: "",
            customer_name: s.name,
            customer_phone: s.phone,
            address: s.address,
            district: area.district,
            city: area.city,
            province: area.province,
            payment_method: s.payment,
            ...(s.payment === "manual_transfer" && sellerBankAccountId
              ? { seller_bank_account_id: sellerBankAccountId }
              : {}),
            variant_id: String(variant.id),
            quantity: 1,
            location_id: area.id,
            courier_service_id: chosen.position + 1,
            shipment_provider_code: chosen.rate.courier_code,
            shipping_cost: chosen.rate.price,
          },
        }),
      );
      const orderId = Number(submitted?.order?.id);
      if (!orderId) continue;
      if (s.markPaid) {
        ok(`mark paid #${orderId}`, await call(`/api/admin/orders/${orderId}`, { method: "PATCH", json: { payment_status: "paid" } }));
      }
      if (s.finalChannel === "external") {
        ok(
          `external channel #${orderId}`,
          await call(`/api/admin/orders/${orderId}`, {
            method: "PATCH",
            json: {
              shipping_channel: "external",
              courier_code: s.courier || "JNE",
              cnote_no: s.cnote || `DEMO-EXT-${orderId}`,
              shipping_status: "shipped",
            },
          }),
        );
        if (s.finalStatus === "delivered" || s.finalStatus === "returned") {
          ok(
            `advance ${s.finalStatus} #${orderId}`,
            await call(`/api/admin/orders/${orderId}`, {
              method: "PATCH",
              json: { shipping_status: s.finalStatus },
            }),
          );
        }
      }
      console.log(`[seed:demo-live] showcase order #${orderId} (${s.payment}, ${s.finalChannel} → ${s.finalStatus})`);
    }
  } else {
    console.log(`[seed:demo-live] already has ${existingOrders.length} orders — skipping order seed`);
  }

  // 5. Seed 4 realistic abandoned leads for funnel & /admin/orders/abandoned.
  const leadRes = ok("list abandoned", await call("/api/admin/abandoned-orders?limit=20"));
  const existingLeads: any[] = Array.isArray(leadRes?.data) ? leadRes.data : (leadRes?.data?.orders ?? []);
  if (existingLeads.length < 4) {
    const leads = [
      { name: "Rina Wulandari", phone: "081232002001", slug: "kaos-katun-dummy", referer: `${base}/kaos-katun-promo`, utm: { utm_source: "facebook", utm_campaign: "promo_kaos_nov" }, province: "Jawa Barat" },
      { name: "Fajar Nugroho", phone: "081232002002", slug: "serum-wajah-dummy", referer: `${base}/serum-niacinamide-glow`, utm: { utm_source: "tiktok", utm_campaign: "serum_tiktok_live" }, province: "DKI Jakarta" },
      { name: "Yuni Kartika", phone: "081232002003", slug: "madu-hutan-dummy", referer: `${base}/madu-hutan-asli`, utm: { utm_source: "google", utm_campaign: "search_madu_hutan" }, province: "Jawa Timur" },
      { name: "Dian Saputra", phone: "081232002004", slug: "pembersih-kerak-panci-dummy", referer: `${base}/produk/pembersih-kerak-panci-dummy`, utm: { utm_source: "instagram", utm_campaign: "rumah_tangga_reels" }, province: "Banten" },
    ];
    for (const lead of leads) {
      const product = bySlug.get(lead.slug);
      const variant = product?.variants?.[0];
      if (!product || !variant) continue;
      const clickCookie = `adsbook_click_ids=${encodeURIComponent(JSON.stringify(lead.utm))}`;
      await call("/api/record-abandoned-order", {
        method: "POST",
        headers: { Referer: lead.referer, Cookie: clickCookie },
        json: {
          customer_name: lead.name,
          customer_phone: lead.phone,
          product_id: product.id,
          variant_id: variant.id,
          product_title: product.title,
          province: lead.province,
          total_amount: variant.price,
          website: "",
        },
      });
    }
    console.log("[seed:demo-live] showcase abandoned leads recorded");
  } else {
    console.log(`[seed:demo-live] already has ${existingLeads.length} leads — skipping lead seed`);
  }
}

main().catch((error) => {
  console.error(`[seed:demo-live] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
