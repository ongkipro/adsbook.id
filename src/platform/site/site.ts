/**
 * The adsbook.id marketing site (T-40, PR-25): page metadata, canonical URLs,
 * structured data, and the platform's own conversion tracking.
 *
 * Platform tracking is separate from every seller's: its own Pixel id
 * (`PLATFORM_META_PIXEL_ID`, public) and Conversions API token
 * (`PLATFORM_META_CAPI_TOKEN`, a Worker secret), read only here and only on
 * platform hosts. Nothing in this module is reachable from a seller host.
 */
import { META_GRAPH_API_VERSION } from "../../lib/meta-capi.ts";
import { sha256Hex } from "../../lib/meta-identity.ts";

export const SITE_NAME = "adsbook.id";
export const SIGNUP_PATH = "/daftar";
export const SIGNUP_LABEL = "Coba buat toko gratis";
/** The header's small button: the same action, short enough for a 360px header. */
export const SIGNUP_LABEL_SHORT = "Coba gratis";

export type SitePage = {
  path: string;
  /** The header label; on an inner page also the visible breadcrumb and its BreadcrumbList. */
  nav?: string;
  title: string;
  description: string;
  noindex?: boolean;
  /** 1200×630 PNG under public/, made by `npm run platform-visuals` (PLATFORM-SEO-AND-VISUAL-BANNERS-SPEC §4). */
  ogImage?: string;
  ogImageAlt?: string;
};

/** The share card a page without its own uses (sign-up, sign-in). */
export const DEFAULT_OG = { image: "/og/og-home.png", alt: "adsbook.id: satu pesanan, satu konversi ke Meta, Google, dan TikTok" } as const;

export const SIGNUP_PAGE: SitePage = {
  path: "/daftar",
  title: "Buat Toko Gratis di Mode Preview - adsbook.id",
  description: "Daftar dan siapkan toko online COD Anda di Mode Preview tanpa biaya. Aktifkan langganan mulai Rp149.000 per bulan saat toko siap beriklan.",
  noindex: true,
};

/** adsbook.id/masuk: one sign-in door for every store (AUTH-LOGIN-REGISTER-UX-SPEC §2.3). */
export const LOGIN_PATH = "/masuk";
export const LOGIN_PAGE: SitePage = {
  path: LOGIN_PATH,
  title: "Masuk ke Dashboard Toko - adsbook.id",
  description: "Masuk ke dashboard toko adsbook.id dengan email pemilik atau username tim Anda. Sistem langsung membuka admin toko Anda tanpa perlu mengetik alamat toko.",
  noindex: true,
};

/** One entry per indexable page; titles ≤ 70 and descriptions 120–155 characters (copy QA gate). */
export const SITE_PAGES: Record<"home" | "fitur" | "caraKerja" | "harga" | "faq" | "kontak" | "syarat" | "privasi", SitePage> = {
  home: {
    path: "/",
    title: "Landing Page, Checkout Form, dan Tracking Konversi - adsbook.id",
    description: "Terima pesanan COD dan jual produk digital dari toko sendiri. Lacak konversi iklan dengan data dari browser dan server untuk mengukur hasil kampanye.",
    ogImage: DEFAULT_OG.image,
    ogImageAlt: DEFAULT_OG.alt,
  },
  fitur: {
    path: "/fitur",
    nav: "Fitur",
    title: "Fitur Toko Online: Checkout COD dan Kelola Pesanan - adsbook.id",
    description: "Siapkan landing page dengan form pemesanan, cek ongkir otomatis, dan pilihan COD atau QRIS. Kelola pesanan dan pantau hasil iklan dari panel toko.",
    ogImage: "/og/og-fitur.png",
    ogImageAlt: "Fitur adsbook.id: produk fisik COD, produk digital, dan sinyal 1:1 ke tiga platform iklan",
  },
  caraKerja: {
    path: "/cara-kerja",
    nav: "Cara kerja",
    title: "Cara Kerja Toko Online: dari Klik Iklan ke Pesanan - adsbook.id",
    description: "Lihat alur pembeli dari klik iklan ke landing page dan checkout, lalu bagaimana toko mengelola pesanan, mengirim paket, dan mencatat konversi.",
    ogImage: "/og/og-cara-kerja.png",
    ogImageAlt: "Cara kerja adsbook.id: lima langkah dari klik iklan sampai konversi tercatat",
  },
  harga: {
    path: "/harga",
    nav: "Harga",
    title: "Harga Langganan Toko Online dan Mode Preview - adsbook.id",
    description: "Mode Preview gratis untuk menyiapkan toko. Langganan Rp149.000 per 30 hari atau Rp1.490.000 per tahun diperlukan untuk menerima pesanan.",
    ogImage: "/og/og-harga.png",
    ogImageAlt: "Harga adsbook.id: Rp149.000 per bulan per toko, 0% potongan transaksi",
  },
  faq: {
    path: "/faq",
    nav: "FAQ",
    title: "Pertanyaan Umum tentang Biaya, Domain, dan Toko - adsbook.id",
    description: "Jawaban atas pertanyaan tentang biaya langganan, domain sendiri, pengiriman COD, akun pembayaran, dan pengelolaan data pembeli di adsbook.id.",
    ogImage: "/og/og-faq.png",
    ogImageAlt: "Pusat jawaban adsbook.id untuk seller dan pengiklan",
  },
  kontak: {
    path: "/kontak",
    nav: "Kontak",
    title: "Kontak dan Dukungan untuk Pemilik Toko dan Pembeli - adsbook.id",
    description: "Informasi kontak untuk bantuan akun, pengelolaan toko, dan privasi. Pertanyaan tentang pesanan ditangani langsung oleh toko tempat Anda membeli.",
    ogImage: "/og/og-kontak.png",
    ogImageAlt: "Kontak adsbook.id: dukungan seller dan perlindungan data pembeli",
  },
  syarat: {
    path: "/syarat",
    title: "Syarat Penggunaan Platform untuk Pemilik Toko - adsbook.id",
    description: "Syarat penggunaan adsbook.id bagi pemilik toko: layanan, akun, penyedia pihak ketiga milik Anda sendiri, data, penangguhan, dan perubahan syarat.",
    ogImage: "/og/og-legal.png",
    ogImageAlt: "Dokumen syarat layanan dan kebijakan privasi adsbook.id",
  },
  privasi: {
    path: "/privasi",
    title: "Kebijakan Privasi dan Pengelolaan Data Pengguna - adsbook.id",
    description: "Data apa yang diproses adsbook.id untuk seller dan pengunjung, untuk apa, di mana disimpan, dan cara meminta salinan atau penghapusan data.",
    ogImage: "/og/og-legal.png",
    ogImageAlt: "Dokumen syarat layanan dan kebijakan privasi adsbook.id",
  },
};

/** The site's canonical origin: `PLATFORM_SITE_URL`, else the production apex. */
export function siteOrigin(env: Record<string, unknown> | null | undefined): string {
  const value = typeof env?.PLATFORM_SITE_URL === "string" ? env.PLATFORM_SITE_URL.trim() : "";
  try {
    return value ? new URL(value).origin : "https://adsbook.id";
  } catch {
    return "https://adsbook.id";
  }
}

export function canonicalUrl(env: Record<string, unknown> | null | undefined, path: string): string {
  return new URL(path, siteOrigin(env)).href;
}

/**
 * JSON-LD per page: `WebSite` (site name, the home only), `Organization` with a
 * 192 px logo, `SoftwareApplication`, and on an inner page with a visible
 * breadcrumb (`nav`) its `BreadcrumbList`. No rating, review or customer
 * count: we have none.
 */
export function siteJsonLd(env: Record<string, unknown> | null | undefined, page: SitePage = SITE_PAGES.home): string {
  const origin = siteOrigin(env);
  const crumb = breadcrumbName(page);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      ...(page.path === "/" ? [{ "@type": "WebSite", "@id": `${origin}/#website`, name: SITE_NAME, url: `${origin}/`, inLanguage: "id-ID", publisher: { "@id": `${origin}/#organization` } }] : []),
      // 192 × 192 PNG: above Google's 112 px minimum, readable on white.
      { "@type": "Organization", "@id": `${origin}/#organization`, name: SITE_NAME, url: `${origin}/`, logo: `${origin}/favicon-192.png` },
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        url: `${origin}/`,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        inLanguage: "id-ID",
        description: SITE_PAGES.home.description,
        publisher: { "@id": `${origin}/#organization` },
        // ADR-041 Option A, per store (src/platform/billing.ts BILLING_CYCLES).
        offers: [
          { "@type": "Offer", name: "1 Bulan", price: "149000", priceCurrency: "IDR" },
          { "@type": "Offer", name: "3 Bulan", price: "399000", priceCurrency: "IDR" },
          { "@type": "Offer", name: "6 Bulan", price: "759000", priceCurrency: "IDR" },
          { "@type": "Offer", name: "1 Tahun", price: "1490000", priceCurrency: "IDR" },
        ],
      },
      ...(crumb
        ? [{
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: BREADCRUMB_HOME, item: `${origin}/` },
              { "@type": "ListItem", position: 2, name: crumb, item: canonicalUrl(env, page.path) },
            ],
          }]
        : []),
    ],
  };
  // `</` cannot close the script element it is embedded in.
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}

export const BREADCRUMB_HOME = "Beranda";

/** The visible breadcrumb's last item (PageHead), or null on the home and pages outside the header. */
export function breadcrumbName(page: SitePage): string | null {
  return page.path !== "/" && page.nav && !page.noindex ? page.nav : null;
}

/** The share image of a page as an absolute URL, with its alt text. */
export function ogImageFor(env: Record<string, unknown> | null | undefined, page: SitePage): { url: string; alt: string } {
  return page.ogImage
    ? { url: canonicalUrl(env, page.ogImage), alt: page.ogImageAlt ?? DEFAULT_OG.alt }
    : { url: canonicalUrl(env, DEFAULT_OG.image), alt: DEFAULT_OG.alt };
}

/** `/llms.txt` of the site (llmstxt.org): honest facts and the public pages, never sign-in, admin or APIs. */
export function platformLlmsTxt(env: Record<string, unknown> | null | undefined): string {
  const pages = Object.values(SITE_PAGES).map((page) => `- [${page.title.replace(/ - adsbook\.id$/, "")}](${canonicalUrl(env, page.path)}): ${page.description}`);
  return [
    `# ${SITE_NAME}`,
    "",
    "> Platform toko online untuk pengiklan di Indonesia, dengan landing page, checkout form, dan tracking konversi. Mendukung produk fisik dengan COD dan produk digital dengan akses otomatis setelah pembayaran lunas.",
    "",
    "- Satu toko per langganan, di alamat nama-toko.adsbook.my.id atau domain sendiri.",
    "- Mode Preview gratis tanpa batas waktu persiapan. Untuk menerima pesanan, aktifkan langganan melalui QRIS atau Virtual Account. Paket 30 hari Rp149.000; paket tahunan Rp1.490.000.",
    "- 0% potongan transaksi: ongkir dan pembayaran memakai akun kurir dan payment gateway milik seller sendiri.",
    "- Jika tracking aktif, konversi COD dicatat saat pesanan dibuat. Konversi QRIS dan Virtual Account dicatat saat pembayaran lunas.",
    "- Masa tenggang langganan berlangsung 48 jam setelah jatuh tempo.",
    "",
    "## Halaman",
    "",
    ...pages,
    "",
  ].join("\n");
}

/** The platform Pixel id, or null when unset or not a Pixel-shaped id. */
export function platformPixelId(env: Record<string, unknown> | null | undefined): string | null {
  const value = typeof env?.PLATFORM_META_PIXEL_ID === "string" ? env.PLATFORM_META_PIXEL_ID.trim() : "";
  return /^\d{10,20}$/.test(value) ? value : null;
}

const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A browser-supplied event id, kept only when it is a plausible one; else a fresh one (no dedup possible then). */
export function registrationEventId(value: unknown): string {
  return typeof value === "string" && EVENT_ID.test(value) ? value : crypto.randomUUID();
}

export type RegistrationSignal = {
  eventId: string;
  email: string;
  phone?: string | null;
  sourceUrl: string;
  ip: string | null;
  userAgent: string | null;
  fbp?: string | null;
  fbc?: string | null;
  now?: Date;
};

/**
 * `CompleteRegistration` from the server for a signup that succeeded, sharing
 * its `event_id` with the browser's `fbq` call so Meta keeps one. Unset
 * platform credentials send nothing. Never throws: a tracking failure must
 * not touch the signup that already succeeded.
 */
export async function sendCompleteRegistration(
  env: Record<string, unknown> | null | undefined,
  signal: RegistrationSignal | (() => RegistrationSignal),
  fetcher: typeof fetch = fetch,
): Promise<"sent" | "skipped" | "failed"> {
  const pixelId = platformPixelId(env);
  const token = typeof env?.PLATFORM_META_CAPI_TOKEN === "string" ? env.PLATFORM_META_CAPI_TOKEN.trim() : "";
  if (!pixelId || !token) return "skipped";
  try {
    // Everything, preparation included, inside the boundary (T-40 review).
    const input = typeof signal === "function" ? signal() : signal;
    // A local stand-in may replace the Graph origin in development only.
    const base = typeof env?.PLATFORM_META_GRAPH_BASE === "string" && env.PLATFORM_META_GRAPH_BASE ? env.PLATFORM_META_GRAPH_BASE : "https://graph.facebook.com";
    const testCode = typeof env?.PLATFORM_META_TEST_EVENT_CODE === "string" ? env.PLATFORM_META_TEST_EVENT_CODE.trim() : "";
    const body = {
      data: [
        {
          event_name: "CompleteRegistration",
          event_time: Math.floor((input.now ?? new Date()).getTime() / 1000),
          event_id: input.eventId,
          action_source: "website",
          event_source_url: input.sourceUrl,
          user_data: {
            em: [await sha256Hex(input.email.trim().toLowerCase())],
            ...(input.phone ? { ph: [await sha256Hex(input.phone.replace(/\D/g, ""))] } : {}),
            client_ip_address: input.ip || undefined,
            client_user_agent: input.userAgent || undefined,
            fbp: input.fbp || undefined,
            fbc: input.fbc || undefined,
          },
          custom_data: { content_name: "signup", status: "registered" },
        },
      ],
      ...(testCode ? { test_event_code: testCode } : {}),
      // The token travels in the POST body, never in a URL a log could keep.
      // lazy: live acceptance of a body token is checked in T-31 (Meta Test Events).
      access_token: token,
    };
    const response = await fetcher(`${base}/${META_GRAPH_API_VERSION}/${pixelId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return "sent";
    console.error("platform-capi-failed", { status: response.status });
    return "failed";
  } catch (error) {
    // The error's name only: a message can quote a request.
    console.error("platform-capi-failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

/** One cookie's value from a request, for `_fbp`/`_fbc`. */
export function cookieValue(request: Request, name: string): string | null {
  const match = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null; // a malformed cookie is no cookie
  }
}
