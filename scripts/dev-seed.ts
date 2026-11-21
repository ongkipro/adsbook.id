/**
 * `npm run dev:seed` — sign up a demo tenant on a running `npm run dev:local`
 * platform and fill it with dummy products and orders.
 *
 * Everything goes through the platform's own HTTP surface — the signup API on
 * app.localhost, the tenant's /hello login form, the admin APIs, the public
 * checkout endpoints — exactly
 * as a browser would, so a seed run is also a smoke test of those paths: any
 * refusal stops the run and prints the endpoint and the answer.
 *
 * Local only. It refuses any host that is not loopback or a private/tailnet
 * address, and it never runs inside a deploy: nothing in `src/` imports it,
 * and no migration seeds data (a demo seed shipped once and reached a real
 * merchant; see ARCHITECTURE.md). The products are invented for this script.
 *
 *   --platform=http://app.localhost:8787   platform host (default)
 *   --explorer=http://127.0.0.1:8787       where Wrangler's local email capture answers
 *                                 (default: loopback on the platform's port). The signup
 *                                 mails a verification code (T-58); the seed reads it there.
 *   --slug=toko-uji                        the tenant to sign up (default)
 *   --catalogue-only              signup, sign-in and products only: no provider
 *                                 keys, no warehouse, no orders. The only mode
 *                                 allowed for `demo`, the display-only demo store
 *                                 (PR-26, `npm run seed:demo`), which must never
 *                                 hold a provider credential.
 *   --preview                     a ready store (keys, warehouse, products) left
 *                                 in Preview Mode: no subscription, no orders.
 *   --orders=12                   how many checkout orders to place
 *   --store-name="Toko Dummy Lokal"  the store name given at signup
 *   --images=<dir>                product photos: <dir>/<slug>.webp|.jpg|.png
 *                                 replace the flat colour for that product;
 *                                 they go through the admin's image rules.
 *                                 Keep the folder outside the repository —
 *                                 another merchant's photos must never be
 *                                 committed here (AGENTS.md §3, Content).
 *
 * Re-running is safe: signup is skipped once the slug exists, a product whose slug
 * exists is left alone, and each run adds another batch of orders.
 */
import { existsSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { prepareImage } from "./prepare-image.ts";
import { loopbackOrigin, readVerificationCode, sentVerificationIds } from "./dev-mailbox.ts";

const argValue = (name: string) =>
  process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const platform = new URL((argValue("platform") || "http://app.localhost:8787").replace(/\/$/, ""));
const slug = argValue("slug") || "toko-uji";
const catalogueOnly = process.argv.slice(2).includes("--catalogue-only");
/** A ready store left in Preview Mode (ADR-041): no subscription, no orders. */
const previewOnly = process.argv.slice(2).includes("--preview");
if (slug === "demo" && !catalogueOnly) {
  console.error("[dev:seed] refusing slug demo without --catalogue-only: the demo store never holds provider keys (PR-26). Use npm run seed:demo.");
  process.exit(1);
}
// The tenant answers on <slug>.localhost, same scheme and port (dev:local's TENANT_HOST_SUFFIX).
const base = `${platform.protocol}//${slug}.localhost${platform.port ? `:${platform.port}` : ""}`;
const orderCount = Math.max(1, Math.min(50, Number(argValue("orders")) || 12));
const imageDir = argValue("images");
const providerBase = (() => {
  return `http://127.0.0.1:${Number(platform.port || 80) + 1}`;
})();

// The owner the signup creates; signs in at /hello with the email (IAM-10).
const DEV_ADMIN = { username: `owner@${slug}.local.test`, password: "dev-local-password-123" } as const;

const host = platform.hostname;
const isLocalHost =
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^127\./.test(host) ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host); // tailnet CGNAT
if (!isLocalHost) {
  console.error(`[dev:seed] refusing ${base}: only a local dev:local store may be seeded.`);
  process.exit(1);
}

let cookie = "";

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", base);
  // What a current browser sends on a same-origin call (IAM-5 strict CSRF).
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
    payload = text;
  }
  return { status: response.status, payload, headers: response.headers };
}

function fail(step: string, result: { status: number; payload: unknown }): never {
  const detail = typeof result.payload === "string" ? result.payload.slice(0, 300) : JSON.stringify(result.payload);
  throw new Error(`${step} → HTTP ${result.status}: ${detail}`);
}

function ok(step: string, result: { status: number; payload: any }) {
  if (result.status >= 400 || result.payload?.success === false) fail(step, result);
  return result.payload;
}

// ── A solid-colour PNG, so products carry a real uploaded image ─────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function solidPng(rgb: [number, number, number], size = 480) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = new Uint8Array(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y += 1) raw.set(row, y * row.length);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const IMAGE_TYPES: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

function productImage(slug: string, color: [number, number, number]) {
  for (const [extension, type] of Object.entries(IMAGE_TYPES)) {
    const path = imageDir ? `${imageDir.replace(/\/$/, "")}/${slug}.${extension}` : "";
    if (path && existsSync(path)) return new File([readFileSync(path)], `${slug}.${extension}`, { type });
  }
  return new File([solidPng(color)], `${slug}.png`, { type: "image/png" });
}


// ── Invented catalogue ──────────────────────────────────────────────────────
const PRODUCTS = [
  {
    title: "Kaos Katun Dummy",
    slug: "kaos-katun-dummy",
    category: "Pakaian",
    color: [37, 99, 235] as [number, number, number],
    variants: [
      { sku: "DUMMY-KAOS-S", title: "S", price: 79000, compare_price: 99000, weight_grams: 250 },
      { sku: "DUMMY-KAOS-M", title: "M", price: 79000, compare_price: 99000, weight_grams: 260 },
      { sku: "DUMMY-KAOS-L", title: "L", price: 85000, compare_price: 105000, weight_grams: 280 },
    ],
  },
  {
    title: "Madu Hutan Dummy",
    slug: "madu-hutan-dummy",
    category: "Makanan",
    color: [217, 119, 6] as [number, number, number],
    variants: [
      { sku: "DUMMY-MADU-250", title: "250 ml", price: 65000, compare_price: null, weight_grams: 400 },
      { sku: "DUMMY-MADU-500", title: "500 ml", price: 120000, compare_price: 135000, weight_grams: 750 },
    ],
  },
  {
    title: "Tas Selempang Dummy",
    slug: "tas-selempang-dummy",
    category: "Aksesoris",
    color: [22, 163, 74] as [number, number, number],
    variants: [{ sku: "DUMMY-TAS-HITAM", title: "Hitam", price: 149000, compare_price: 199000, weight_grams: 600 }],
  },
  {
    title: "Serum Wajah Dummy",
    slug: "serum-wajah-dummy",
    category: "Kecantikan",
    color: [219, 39, 119] as [number, number, number],
    variants: [
      { sku: "DUMMY-SERUM-20", title: "20 ml", price: 89000, compare_price: 119000, weight_grams: 150 },
      { sku: "DUMMY-SERUM-50", title: "50 ml", price: 179000, compare_price: null, weight_grams: 220 },
    ],
  },
  {
    title: "Lampu Dinding Solar Dummy",
    slug: "lampu-dinding-solar-dummy",
    category: "Rumah Tangga",
    color: [234, 179, 8] as [number, number, number],
    variants: [
      { sku: "DUMMY-SOLAR-1", title: "1 pcs", price: 69000, compare_price: 89000, weight_grams: 350 },
      { sku: "DUMMY-SOLAR-2", title: "2 pcs", price: 129000, compare_price: 178000, weight_grams: 700 },
    ],
  },
  {
    title: "Holder HP Motor Dummy",
    slug: "holder-hp-motor-dummy",
    category: "Otomotif",
    color: [15, 23, 42] as [number, number, number],
    variants: [{ sku: "DUMMY-HOLDER-1", title: "Hitam", price: 55000, compare_price: 75000, weight_grams: 300 }],
  },
  {
    title: "Senter LED Mini Dummy",
    slug: "senter-led-mini-dummy",
    category: "Perlengkapan",
    color: [8, 145, 178] as [number, number, number],
    variants: [{ sku: "DUMMY-SENTER-1", title: "Default", price: 45000, compare_price: 60000, weight_grams: 200 }],
  },
  {
    title: "Lem Serbaguna Dummy",
    slug: "lem-serbaguna-dummy",
    category: "Perkakas",
    color: [124, 58, 237] as [number, number, number],
    variants: [
      { sku: "DUMMY-LEM-50", title: "50 g", price: 35000, compare_price: null, weight_grams: 120 },
      { sku: "DUMMY-LEM-100", title: "100 g", price: 59000, compare_price: 70000, weight_grams: 220 },
    ],
  },
  {
    title: "Pembersih Kerak Panci Dummy",
    slug: "pembersih-kerak-panci-dummy",
    category: "Rumah Tangga",
    color: [5, 150, 105] as [number, number, number],
    variants: [{ sku: "DUMMY-KERAK-1", title: "250 ml", price: 49000, compare_price: 65000, weight_grams: 350 }],
  },
  {
    title: "Pembersih Saluran Dummy",
    slug: "pembersih-saluran-dummy",
    category: "Rumah Tangga",
    color: [71, 85, 105] as [number, number, number],
    variants: [
      { sku: "DUMMY-SALURAN-1", title: "1 botol", price: 39000, compare_price: 55000, weight_grams: 500 },
      { sku: "DUMMY-SALURAN-3", title: "3 botol", price: 99000, compare_price: 165000, weight_grams: 1500 },
    ],
  },
  {
    // Inactive on purpose: it must stay off the storefront and out of checkout.
    title: "Produk Draft Dummy",
    slug: "produk-draft-dummy",
    category: "Umum",
    color: [100, 116, 139] as [number, number, number],
    is_active: false,
    variants: [{ sku: "DUMMY-DRAFT-1", title: "Default", price: 50000, compare_price: null, weight_grams: 500 }],
  },
];

const BUYERS = [
  { name: "Siti Rahayu", phone: "081234500001", area: "Coblong Bandung", address: "Jl. Dago No. 12, RT 01/RW 02" },
  { name: "Budi Santoso", phone: "081234500002", area: "Tebet Jakarta Selatan", address: "Jl. Tebet Raya No. 5" },
  { name: "Dewi Lestari", phone: "081234500003", area: "Gubeng Surabaya", address: "Jl. Kertajaya No. 88" },
  { name: "Agus Prasetyo", phone: "081234500004", area: "Tembalang Semarang", address: "Jl. Banjarsari No. 3" },
  { name: "Rina Wulandari", phone: "081234500005", area: "Depok Sleman", address: "Jl. Kaliurang Km 7" },
  { name: "Hendra Wijaya", phone: "081234500006", area: "Medan Baru Medan", address: "Jl. Sei Batang Hari No. 21" },
];

/**
 * Where Wrangler's local email capture (Miniflare's Local Explorer) answers: the same port as the platform, but on
 * loopback, because the Explorer accepts only a loopback Host (`app.localhost` is refused). `--explorer=` overrides it.
 * Only `scripts/dev-mailbox.ts` reads it; see that file for what the Explorer is and why it must stay on loopback.
 */
const explorerOrigin = argValue("explorer") || `http://127.0.0.1:${platform.port || 80}`;

async function postSignup(body: Record<string, unknown>) {
  const response = await fetch(`${platform.origin}/api/platform/signup`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: platform.origin, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ ...body, turnstile_token: "local-stand-in" }),
  });
  return { status: response.status, payload: (await response.json().catch(() => null)) as any };
}

/**
 * Sign the demo tenant up on the platform host, as the signup page does, in its two phases (T-58, PR-11): ask for
 * the code, read it from the local mailbox, send the signup with it. There is no way around the proof: a server
 * that does not verify the mailbox is not what this script is for, and it fails here instead of seeding.
 */
async function signupTenant() {
  loopbackOrigin(explorerOrigin);
  // The mail is read from a capture that other runs also write to: remember what is there before asking for a new one.
  // An unreachable capture is only fatal once a code is actually needed: a re-run for a tenant that already exists
  // still skips its signup without it ("Re-running is safe").
  const seen = await sentVerificationIds(explorerOrigin, DEV_ADMIN.username).catch((error: unknown) => error as Error);
  const requested = await postSignup({ action: "request_email_code", email: DEV_ADMIN.username });
  // An email that already owns a store is refused on the code request too (no cheaper oracle): that is the same "exists".
  if (requested.status === 409 && requested.payload?.errors?.email) return console.log(`[dev:seed] tenant ${slug} already exists — skipping signup`);
  ok("request_email_code", requested);
  if (seen instanceof Error) {
    throw new Error(`${seen.message} — the local email capture must be reachable on ${explorerOrigin} (dev:local on loopback, Local Explorer on)`);
  }
  const challengeId = requested.payload?.challenge_id;
  if (typeof challengeId !== "string" || !challengeId) fail("request_email_code (no challenge_id)", requested);
  const code = await readVerificationCode(DEV_ADMIN.username, { explorer: explorerOrigin, ignore: seen });
  const response = await postSignup({
    store_name: argValue("store-name") || "Toko Dummy Lokal",
    slug,
    email: DEV_ADMIN.username,
    password: DEV_ADMIN.password,
    terms: true,
    challenge_id: challengeId,
    email_code: code,
  });
  if (response.status === 409) return console.log(`[dev:seed] tenant ${slug} already exists — skipping signup`);
  ok("signup", response);
  console.log(`[dev:seed] signed up ${base} (mailbox code verified)`);
}

/** Point the tenant's own provider settings at the local stand-ins (T-45: never env). */
async function providers() {
  ok("providers", await call("/api/admin/settings", {
    method: "PUT",
    json: {
      action: "save-integrations",
      integrations: {
        mengantar_api_key: "dev",
        mengantar_base_url: providerBase,
        // Payment-only profile: the key is all a seller enters (AUTOLARIS_INTEGRATION_SPEC §4).
        autolaris_api_key: "dev",
        autolaris_base_url: providerBase,
      },
    },
  }));
  console.log("[dev:seed] provider stand-ins saved for this tenant");
}

async function login() {
  const form = new URLSearchParams(DEV_ADMIN);
  const result = await call("/hello", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const setCookie = result.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((value) => value.split(";")[0]).find((value) => value.startsWith("__Host-adsbook_session="));
  if (!session) fail("login (/hello)", result);
  cookie = session;
  console.log("[dev:seed] logged in as", DEV_ADMIN.username);
}

async function firstArea(keyword: string) {
  const result = await call(`/api/locations?search=${encodeURIComponent(keyword)}`);
  const payload = ok(`locations ${keyword}`, result);
  const rows = payload?.items ?? payload?.locations ?? [];
  if (!rows.length) fail(`locations ${keyword} (no rows)`, result);
  return rows[0];
}

async function warehouse() {
  const current = ok("settings", await call("/api/admin/settings"));
  if (current?.data?.warehouse?.id) {
    return console.log("[dev:seed] warehouse already configured — skipping");
  }
  const area = await firstArea("Menteng Jakarta Pusat");
  ok(
    "save-warehouse",
    await call("/api/admin/settings", {
      method: "PUT",
      json: {
        action: "save-warehouse",
        warehouse: {
          name: "Gudang Dummy Jakarta",
          contact_name: "Operator Gudang",
          contact_phone: "6281234500009",
          origin_area_id: area.id ?? area.location_id ?? area._id,
          origin_label: area.label ?? [area.district, area.city].filter(Boolean).join(", "),
          address: "Jl. Cikini Raya No. 1",
          city: area.city ?? "Jakarta Pusat",
          province: area.province ?? "DKI Jakarta",
        },
      },
    }),
  );
  console.log("[dev:seed] warehouse saved");
}

async function products() {
  const existing = ok("products list", await call("/api/admin/products"));
  const rows: any[] = existing?.data?.products ?? existing?.data ?? existing?.products ?? [];
  const slugs = new Set(rows.map((row) => row.slug));
  for (const product of PRODUCTS) {
    if (slugs.has(product.slug)) {
      console.log(`[dev:seed] product ${product.slug} exists — skipping`);
      continue;
    }
    // Through the same rules as the admin (scripts/prepare-image.ts): WebP 480 px + JPEG 1024 px for the feeds.
    const source = productImage(product.slug, product.color);
    const prepared = await prepareImage(new Uint8Array(await source.arrayBuffer()), product.slug, { feed: true });
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
      const feed = await call("/api/admin/upload-r2", { method: "POST", body: feedForm });
      if (feed.status >= 400) console.warn(`[dev:seed] catalog copy for ${product.slug} → HTTP ${feed.status}`);
    }
    ok(
      `create ${product.slug}`,
      await call("/api/admin/products", {
        method: "POST",
        json: {
          title: product.title,
          slug: product.slug,
          category: product.category,
          image_url: imageUrl,
          is_active: product.is_active ?? true,
          variants: product.variants.map((variant) => ({ ...variant, stock: 100 })),
        },
      }),
    );
    console.log(`[dev:seed] product ${product.slug} created`);
  }
}

async function activeVariants() {
  const payload = ok("products list", await call("/api/admin/products"));
  const rows: any[] = payload?.data?.products ?? payload?.data ?? payload?.products ?? [];
  return rows
    .filter((row) => row.is_active === 1 || row.is_active === true)
    .flatMap((row) => (row.variants ?? []).map((variant: any) => ({ product: row, variant })));
}

const PAYMENTS = [
  { method: "cod", channel: undefined },
  { method: "cod", channel: undefined },
  { method: "qris", channel: "QRIS" },
  { method: "cod", channel: undefined },
  { method: "bank_transfer", channel: "VABCA" },
  { method: "qris", channel: "QRIS" },
] as const;

type Placed = { id: number; orderNumber: string; payment: string; buyer: string; total: number };

// Checkout folds an identical buyer + variant + total inside its dedupe window
// into the earlier order (a double-submit guard), so each run needs its own
// phone numbers to create new orders rather than replay old ones.
const runSuffix = String(Date.now()).slice(-5);

async function placeOrders(catalogue: { product: any; variant: any }[]) {
  const placed: Placed[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const buyer = BUYERS[index % BUYERS.length];
    const { product, variant } = catalogue[index % catalogue.length];
    const payment = PAYMENTS[index % PAYMENTS.length];
    const area = await firstArea(buyer.area);
    const variantId = String(variant.id);
    const quote = ok(
      `shipping-options ${buyer.area}`,
      await call(
        `/api/shipping-options?${new URLSearchParams({
          location_id: area.id,
          variant_unique_id: variantId,
          payment_method: payment.method,
          city: area.city,
        })}`,
      ),
    );
    const rates: any[] = quote.rates ?? [];
    const eligible = rates
      .map((rate, position) => ({ rate, position }))
      .filter(({ rate }) => !rate.unsupported && (payment.method !== "cod" || !rate.unsupported_cod));
    if (!eligible.length) fail(`no eligible rate for ${buyer.area}`, { status: 200, payload: quote });
    // Spread orders across couriers so the admin lists look like a real day.
    const rateIndex = eligible[index % eligible.length].position;
    const rate = rates[rateIndex];
    const submit = () => call("/api/submit-order", {
      method: "POST",
      json: {
        submit_token: `dev-seed-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
        website: "",
        customer_name: buyer.name,
        customer_phone: `${buyer.phone.slice(0, 7)}${runSuffix}`,
        address: buyer.address,
        district: area.district,
        payment_method: payment.method,
        payment_channel: payment.channel,
        variant_id: variantId,
        city: area.city,
        province: area.province,
        quantity: 1,
        location_id: area.id,
        courier_service_id: rateIndex + 1,
        shipment_provider_code: rate.courier_code,
        shipping_cost: rate.price,
      },
    });
    let result = await submit();
    if (result.status === 429) {
      // Checkout allows 10 submissions per IP per minute; wait the window out.
      console.log("[dev:seed] checkout rate limit reached (10/min per IP) — waiting 61 s");
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      result = await submit();
    }
    const payload = ok(`submit-order #${index + 1} (${payment.method}, ${product.slug})`, result);
    const order = payload.order;
    if (payment.method !== "cod" && payload.payment?.error) {
      fail(`payment for ${order.order_number}`, { status: 200, payload: payload.payment });
    }
    if (placed.some((earlier) => earlier.id === Number(order.id))) {
      fail(`submit-order #${index + 1} replayed ${order.order_number}`, { status: 200, payload });
    }
    placed.push({ id: Number(order.id), orderNumber: String(order.order_number), payment: payment.method, buyer: buyer.name, total: Number(order.total_payment) });
    console.log(`[dev:seed] order ${order.order_number} ${payment.method} ${product.slug}/${variant.title} via ${rate.courier_code} total ${order.total_payment}`);
  }
  return placed;
}

async function exerciseLifecycle(placed: Placed[]) {
  // Settle one online payment at the stand-in and let the hourly job see it.
  const online = placed.find((order) => order.payment !== "cod");
  const held: { transaction_id: string; paid: boolean; receiver?: string }[] = online
    ? await (await fetch(`${providerBase}/__dev/autolaris/payments`)).json()
    : [];
  // The store never returns a transaction id; the stand-in's total is the
  // order's payable total, which pins the row this run created.
  const transaction = held.reverse().find((row: any) => !row.paid && row.receiver === online?.buyer && row.total === online?.total);
  if (online && transaction) {
    const settle = await fetch(`${providerBase}/__dev/autolaris/pay?transaction_id=${encodeURIComponent(transaction.transaction_id)}`, { method: "POST" });
    if (!settle.ok) throw new Error(`settle ${online.orderNumber} → HTTP ${settle.status}`);
    // wrangler dev answers its scheduled trigger on `localhost` only.
    const cron = await fetch(`${platform.protocol}//localhost${platform.port ? `:${platform.port}` : ""}/cdn-cgi/handler/scheduled?cron=7+*+*+*+*`);
    console.log(`[dev:seed] settled ${online.orderNumber}; scheduled job HTTP ${cron.status}`);
  }
  // Release two COD orders to the courier stand-in; leave the rest pending.
  const cod = placed.filter((order) => order.payment === "cod" && order.id > 0);
  if (cod.length) {
    const ids = cod.slice(0, 2).map((order) => order.id);
    const result = ok("dispatch-orders", await call("/api/admin/orders", { method: "POST", json: { action: "dispatch-orders", orderIds: ids } }));
    console.log("[dev:seed] dispatched", ids.join(", "), JSON.stringify(result?.data ?? result).slice(0, 200));
  }
  // Cancel one pending COD order through the shared lifecycle.
  const cancel = cod[2];
  if (cancel) {
    ok(`cancel ${cancel.orderNumber}`, await call(`/api/admin/orders/${cancel.id}`, { method: "PATCH", json: { payment_status: "cancelled" } }));
    console.log(`[dev:seed] cancelled ${cancel.orderNumber}`);
  }
}

/**
 * ADR-041: a new store is in Preview Mode and refuses orders. Subscribe it the
 * way a seller does — an Option A invoice from /admin/billing, paid at the
 * AutoLaris stand-in, credited by the Advice check — so the run below can order.
 */
async function subscribe() {
  const current = ok("billing", await call("/api/admin/billing"));
  if (current?.data?.state === "subscribed" || current?.data?.state === "grace") {
    console.log("[dev:seed] subscription already active — skipping");
    return;
  }
  const created = ok("billing invoice", await call("/api/admin/billing", { method: "POST", json: { cycle: "1m", channel: "QRIS" } }));
  const invoice = created.data.invoice;
  const held = await fetch(`${providerBase}/__dev/autolaris/payments`).then((response) => response.json() as Promise<Array<{ transaction_id: string; paid: boolean; total: number }>>);
  const match = held.filter((payment) => !payment.paid && payment.total === invoice.total).at(-1);
  if (!match) throw new Error("the AutoLaris stand-in holds no instruction for the subscription invoice");
  await fetch(`${providerBase}/__dev/autolaris/pay?transaction_id=${encodeURIComponent(match.transaction_id)}`, { method: "POST" });
  const checked = ok("billing check", await call(`/api/admin/billing/${encodeURIComponent(invoice.id)}/check`, { method: "POST" }));
  if (checked.data.state !== "subscribed") throw new Error(`subscription not active after payment (${checked.data.outcome})`);
  console.log(`[dev:seed] subscribed until ${checked.data.subscriptionEndsAt} (${invoice.number})`);
}

async function main() {
  await signupTenant();
  await login();
  if (catalogueOnly) {
    await products();
    console.log(`[dev:seed] catalogue ready at ${base} (no provider keys, no orders)`);
    return;
  }
  await providers();
  await warehouse();
  await products();
  if (previewOnly) {
    console.log(`[dev:seed] ready store in Preview Mode at ${base} (no subscription, no orders)`);
    return;
  }
  await subscribe();
  const catalogue = await activeVariants();
  if (!catalogue.length) throw new Error("no active variant to order");
  console.log(`[dev:seed] ${catalogue.length} active variants; placing ${orderCount} orders`);
  const placed = await placeOrders(catalogue);
  await exerciseLifecycle(placed);
  console.log(`[dev:seed] done — log in at ${base}/hello as ${DEV_ADMIN.username} / ${DEV_ADMIN.password}`);
}

main().catch((error) => {
  console.error(`[dev:seed] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
