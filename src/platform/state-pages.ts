/**
 * Store state pages (UX-5): neutral, `noindex`, no seller data, no platform
 * link, never cached. The same body answers every unknown host, so a 404
 * reveals nothing about which hosts or slugs exist.
 */
export type StatePage = "not-found" | "suspended" | "recovery" | "unavailable";

const PAGES: Record<StatePage, { status: number; title: string; body: string }> = {
  "not-found": {
    status: 404,
    title: "Halaman tidak ditemukan",
    body: "Alamat ini tidak mengarah ke toko mana pun. Periksa kembali alamat yang Anda ketik.",
  },
  suspended: {
    status: 403,
    title: "Toko sedang tidak aktif",
    body: "Toko ini sedang tidak dapat diakses. Silakan coba lagi nanti.",
  },
  recovery: {
    status: 503,
    title: "Toko sedang dalam pemeliharaan",
    body: "Toko ini sedang dalam pemeliharaan sebentar. Silakan coba lagi beberapa saat lagi.",
  },
  unavailable: {
    status: 503,
    title: "Layanan sedang tidak tersedia",
    body: "Permintaan tidak dapat diproses saat ini. Silakan coba lagi beberapa saat lagi.",
  },
};

const API_CODES: Record<StatePage, string> = {
  "not-found": "NOT_FOUND",
  suspended: "STORE_SUSPENDED",
  recovery: "STORE_MAINTENANCE",
  unavailable: "SERVICE_UNAVAILABLE",
};

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function statePage(kind: StatePage, pathname: string): Response {
  const page = PAGES[kind];
  const retry: Record<string, string> = page.status === 503 ? { "Retry-After": "60" } : {};
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ success: false, error: page.title, code: API_CODES[kind] }), {
      status: page.status,
      headers: { ...HEADERS, ...retry, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${page.title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fafafa;color:#1c1c1c}main{max-width:28rem;padding:2rem 1.25rem;text-align:center}h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0;color:#4b4b4b}</style></head><body><main><h1>${page.title}</h1><p>${page.body}</p></main></body></html>`;
  return new Response(html, {
    status: page.status,
    headers: { ...HEADERS, ...retry, "Content-Type": "text/html; charset=utf-8" },
  });
}
