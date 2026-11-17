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
 *
 * Env: ADSBOOK_DEMO_OWNER_PASSWORD (required), ADSBOOK_DEMO_OWNER_EMAIL (default demo@adsbook.id).
 */
import { existsSync, readFileSync } from "node:fs";
import { prepareImage } from "./prepare-image.ts";
import { homedir } from "node:os";

const arg = (name: string) => process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
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
  if (cookie) headers.set("Cookie", cookie);
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
  await call("/api/admin/logout", { method: "POST" });
  console.log("[seed:demo-live] done. Next: flag the store is_demo (approved PLATFORM_DB write).");
}

main().catch((error) => {
  console.error(`[seed:demo-live] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
