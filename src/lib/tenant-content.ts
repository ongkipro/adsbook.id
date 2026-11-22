import {
  bannerRefusalMessage,
  isBannerOp,
  loadPublishedHomeContent,
  projectPublishedBanner,
  type HomeContent,
} from "./storefront-content.ts";
import { canAccessAdminRoute, type AdminRole } from "./auth.ts";
import { listPublicLandingPages } from "./landing-pages.ts";
import { tenantDatabase } from "./tenant-database.ts";

export type TenantHomeContent = HomeContent;

export type TenantHomeContentResolution =
  | { state: "ready"; content: TenantHomeContent }
  | { state: "unavailable" };

/**
 * A store that has just been installed has no published home content. It used to
 * be sent to a setup screen before its storefront would render at all, which
 * made a fresh install unusable until an operator filled a form. The catalogue,
 * the store's own name, and its landing pages are already enough to build a
 * home page, so this composes one.
 *
 * `heroSlides` is left empty on purpose: the template borrows product photos and
 * rotates them daily, which is better art than any placeholder.
 */
function defaultHomeContent(
  tenant: App.Locals["tenant"],
  solutions: TenantHomeContent["solutions"],
): TenantHomeContent {
  const description =
    tenant.tagline || tenant.description || `Belanja produk pilihan di ${tenant.name}.`;
  return {
    hero: {
      title: tenant.name,
      description,
      ratingLabel: "Pesanan diproses setiap hari",
    },
    catalog: {
      eyebrow: "Produk kami",
      title: "Produk pilihan",
      description: "Pilih produk, cek varian dan harga, lalu pesan langsung dari halamannya.",
    },
    solutionsHeading: {
      eyebrow: "Halaman",
      title: "Selengkapnya",
      description: "Halaman penawaran yang sedang aktif.",
    },
    proofsHeading: {
      eyebrow: "Ulasan",
      title: "Kata Pembeli",
      description: "Cerita dari pembeli kami.",
    },
    heroHighlights: [{ label: "Siap kirim", icon: "package" }],
    heroSlides: [],
    solutions,
    proofs: [],
  };
}

/**
 * The document a first banner publish starts from when nothing was published:
 * the composed default without landing pages, which every read adds itself.
 */
export function seedHomeContent(tenant: App.Locals["tenant"]): TenantHomeContent {
  return defaultHomeContent(tenant, []);
}

export type BannerPreview =
  | { granted: false }
  | { granted: true; published: TenantHomeContent | null; notice: string | null };

/**
 * `/?preview=banner&op=…&v=…` (R1b). Granted only to a session of this store
 * whose role may open the content tools (owner, admin, advertiser) and that
 * owes no password change; anyone else gets the public page and learns nothing
 * about the draft. A granted preview renders `projectPublishedBanner` — the
 * same function the publish runs — on the row read at version `v`; a stale `v`
 * or a refused operation renders the published page with a notice instead.
 */
export function decideBannerPreview(input: {
  session: { role: AdminRole; mustChangePassword: boolean } | null;
  op: string | null;
  version: string | null;
  row: { version: number; draft_json: string | null; published_json: string | null } | null;
  seed: TenantHomeContent;
}): BannerPreview {
  const { session } = input;
  if (!session || session.mustChangePassword || !canAccessAdminRoute(session.role, "/admin/content")) {
    return { granted: false };
  }
  if (!isBannerOp(input.op)) {
    return { granted: true, published: null, notice: "Operasi pratinjau tidak dikenal." };
  }
  if (!input.row || String(input.row.version) !== input.version) {
    return { granted: true, published: null, notice: "Konten berubah sejak dimuat. Muat ulang Tampilan toko, lalu buka pratinjau lagi." };
  }
  const projected = projectPublishedBanner(input.row, input.op, input.seed);
  if (!projected.ok) return { granted: true, published: null, notice: bannerRefusalMessage(projected) };
  return { granted: true, published: projected.content, notice: null };
}

/**
 * `publishedOverride` is only for the signed-in banner preview: it stands in
 * for the stored published document and goes through the same merge. Every
 * other caller (the storefront, the headless API) passes nothing.
 */
export async function getTenantHomeContent(
  locals?: App.Locals,
  publishedOverride?: TenantHomeContent,
): Promise<TenantHomeContentResolution> {
  const database = tenantDatabase(locals);
  if (!database || typeof database !== "object") {
    console.error("home-content-no-database-binding");
    return { state: "unavailable" };
  }

  const published = publishedOverride
    ? ({ state: "published", content: publishedOverride } as const)
    : await loadPublishedHomeContent(database as D1Database);
  if (published.state === "unavailable") {
    return { state: "unavailable" };
  }
  const unpublished = published.state === "unpublished";

  if (!locals) {
    return unpublished
      ? { state: "unavailable" }
      : { state: "ready", content: published.content };
  }

  try {
    // Read-only public listing: the home page must not write to D1, must not
    // link a page whose product is off, and links a claimed page by the
    // product URL it answers on rather than a 308.
    const cmsSolutions = (await listPublicLandingPages(locals))
      .map((page) => ({
        title: page.title,
        excerpt: page.excerpt || `Informasi ${page.title}`,
        image: page.image || "",
        href: page.href,
        crop: "CMS Landing Page",
      }));

    if (unpublished) {
      return {
        state: "ready",
        content: defaultHomeContent(locals.tenant, cmsSolutions),
      };
    }

    return {
      state: "ready",
      content: {
        ...published.content,
        solutions:
          cmsSolutions.length > 0
            ? [...cmsSolutions, ...published.content.solutions]
            : published.content.solutions,
      },
    };
  } catch (error) {
    console.error("home-landing-pages-load", error);
    return { state: "unavailable" };
  }
}
