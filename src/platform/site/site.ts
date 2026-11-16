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
export const SIGNUP_LABEL = "Buka toko gratis";

export type SitePage = { path: string; nav?: string; title: string; description: string };

/** One entry per indexable page; titles ≤ 70 and descriptions 120–155 characters (copy QA gate). */
export const SITE_PAGES: Record<"home" | "fitur" | "caraKerja" | "harga" | "faq" | "kontak" | "syarat" | "privasi", SitePage> = {
  home: {
    path: "/",
    title: "Toko Online COD untuk Seller Iklan - adsbook.id",
    description: "Ubah traffic iklan jadi pesanan COD yang terkirim dan tercatat sebagai konversi. Toko siap pakai, form order cepat, gratis untuk mulai.",
  },
  fitur: {
    path: "/fitur",
    nav: "Fitur",
    title: "Fitur Toko, Form COD dan Sinyal Iklan - adsbook.id",
    description: "Form order COD dan QRIS/VA, pesanan rapi di admin, kirim lewat kurir, dan konversi iklan dari server. Semua fitur yang dipakai seller iklan.",
  },
  caraKerja: {
    path: "/cara-kerja",
    nav: "Cara kerja",
    title: "Cara Kerja: dari Klik Iklan sampai Paket Terkirim - adsbook.id",
    description: "Lima langkah satu pesanan di adsbook.id: iklan, form COD, pesanan masuk, kirim lewat kurir, lalu konversi tercatat dari server.",
  },
  harga: {
    path: "/harga",
    nav: "Harga",
    title: "Harga: Paket Pilot Gratis untuk Seller - adsbook.id",
    description: "Mulai dengan paket Pilot tanpa biaya dan tanpa persetujuan. Lihat batas pemakaiannya; paket berbayar menyusul dan diumumkan lebih dulu.",
  },
  faq: {
    path: "/faq",
    nav: "FAQ",
    title: "Pertanyaan Umum Seller tentang adsbook.id - adsbook.id",
    description: "Jawaban singkat soal biaya, akun kurir dan pembayaran milik Anda sendiri, domain sendiri, data pembeli, dan cara mulai jualan di adsbook.id.",
  },
  kontak: {
    path: "/kontak",
    nav: "Kontak",
    title: "Kontak Tim adsbook.id untuk Seller dan Pembeli - adsbook.id",
    description: "Hubungi tim adsbook.id untuk pertanyaan akun, toko, atau privasi. Permintaan data pembeli kami teruskan ke toko yang bersangkutan.",
  },
  syarat: {
    path: "/syarat",
    title: "Syarat Layanan Seller - adsbook.id",
    description: "Syarat penggunaan adsbook.id bagi pemilik toko: layanan, akun, penyedia pihak ketiga milik Anda sendiri, data, penangguhan, dan perubahan syarat.",
  },
  privasi: {
    path: "/privasi",
    title: "Kebijakan Privasi Platform - adsbook.id",
    description: "Data apa yang diproses adsbook.id untuk seller dan pengunjung, untuk apa, di mana disimpan, dan cara meminta salinan atau penghapusan data.",
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

/** `Organization` and `SoftwareApplication` JSON-LD. No rating, review or customer count: we have none. */
export function siteJsonLd(env: Record<string, unknown> | null | undefined): string {
  const origin = siteOrigin(env);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${origin}/#organization`, name: SITE_NAME, url: `${origin}/` },
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        url: `${origin}/`,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        inLanguage: "id-ID",
        description: SITE_PAGES.home.description,
        publisher: { "@id": `${origin}/#organization` },
        offers: { "@type": "Offer", name: "Pilot", price: "0", priceCurrency: "IDR" },
      },
    ],
  };
  // `</` cannot close the script element it is embedded in.
  return JSON.stringify(graph).replace(/</g, "\\u003c");
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
