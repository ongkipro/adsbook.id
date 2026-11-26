import type { LucideIcon } from "lucide-react";
import type { AdminRole } from "../../lib/auth";
export type { AdminRole } from "../../lib/auth";
import {
  Activity,
  ChartNoAxesCombined,
  Boxes,
  CircleUserRound,
  ClipboardCheck,
  CreditCard,
  FilePenLine,
  LayoutDashboard,
  Megaphone,
  Package,
  Puzzle,
  Palette,
  Settings,
  ShoppingBag,
  Truck,
  UserX,
} from "lucide-react";
import { SETTINGS_GROUPS, SETTINGS_INDEX } from "./settings-sections.ts";
import {
  ADS_RAIL_GROUPS,
  ANALYTICS_RAIL_GROUPS,
  CHECK_RAIL_GROUPS,
  EXPEDITIONS_RAIL_GROUPS,
  PAYMENTS_RAIL_GROUPS,
} from "./section-rails.ts";

/** Stable adsbook.id visual identity. Storefront tenant theming must not alter admin UI. */
export const ADMIN_ACCENT = "#2563eb";

export type AdminNavItem = {
  id: string;
  href: string;
  label: string;
  shortLabel?: string;
  description: string;
  icon: LucideIcon;
  keywords: string;
  children?: Array<{ href: string; label: string; icon?: LucideIcon }>;
  /** The item's pages carry their own section rail (SettingsLayout), so the desktop sidebar lists no children under it. */
  sectionRail?: boolean;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "Penjualan",
    items: [
      {
        id: "dashboard",
        href: "/admin/dashboard",
        label: "Dashboard",
        description: "Ringkasan performa toko",
        icon: LayoutDashboard,
        keywords: "dashboard ringkasan omzet performa",
      },
      {
        id: "orders",
        href: "/admin/orders",
        label: "Pesanan",
        shortLabel: "Pesanan",
        description: "Validasi dan proses pesanan",
        icon: ShoppingBag,
        keywords: "orders pesanan transaksi pelanggan terbengkalai abandoned leads",
        children: [
          { href: "/admin/orders/abandoned", label: "Pesanan tertinggal", icon: UserX },
        ],
      },
      {
        id: "shipping",
        href: "/admin/shipping",
        label: "Pengiriman",
        description: "Kirim, pickup, dan resi",
        icon: Truck,
        keywords: "shipping pengiriman mengantar pickup resi",
      },
      {
        id: "products",
        href: "/admin/products",
        label: "Katalog",
        description: "Produk, varian, dan landing page",
        icon: Package,
        keywords: "products produk katalog varian stock landing pages tampilan toko banner beranda",
        children: [
          { href: "/admin/landing-pages", label: "Landing page", icon: FilePenLine },
        ],
      },
    ],
  },
  {
    label: "Operasional",
    items: [
      {
        id: "expeditions",
        href: "/admin/expeditions",
        label: "Ekspedisi",
        description: "Kurir dan layanan aktif",
        icon: Boxes,
        keywords: "expedition kurir service rule cod provinsi",
        children: EXPEDITIONS_RAIL_GROUPS.flatMap((group) => group.items)
          .filter((item) => item.href !== "/admin/expeditions")
          .map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
      {
        id: "scoring",
        href: "/admin/check",
        label: "Cek WA, Ongkir & Resi",
        shortLabel: "Cek",
        description: "Riwayat pembeli, tarif, dan lacak resi",
        icon: ClipboardCheck,
        keywords: "check scoring whatsapp ongkir tarif resi tracking lacak paket awb",
        children: CHECK_RAIL_GROUPS.flatMap((group) => group.items)
          .filter((item) => item.href !== "/admin/check")
          .map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
    ],
  },
  {
    label: "Pemasaran",
    items: [
      {
        id: "analytics",
        href: "/admin/analytics",
        label: "Analitik",
        description: "Sumber pesanan, produk, wilayah, dan kampanye",
        icon: ChartNoAxesCombined,
        keywords: "analitik analytics laporan trend produk lokasi waktu utm kampanye campaign",
        children: ANALYTICS_RAIL_GROUPS.flatMap((group) => group.items).map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
      {
        id: "ads",
        href: "/admin/ads",
        label: "Iklan & tracking",
        description: "Sinyal konversi iklan",
        icon: Megaphone,
        keywords: "ads pixel capi google tiktok events api tracking conversion utm link kampanye campaign",
        children: ADS_RAIL_GROUPS.flatMap((group) => group.items)
          .filter((item) => item.href !== "/admin/ads")
          .map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
    ],
  },
  {
    label: "Keuangan & sistem",
    items: [
      {
        id: "payments",
        href: "/admin/payments",
        label: "Pembayaran",
        shortLabel: "Payment",
        description: "Metode dan rekonsiliasi",
        icon: CreditCard,
        keywords: "payments autolaris bank virtual account qris saldo",
        children: PAYMENTS_RAIL_GROUPS.flatMap((group) => group.items)
          .filter((item) => item.href !== "/admin/payments")
          .map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
      // Its own workspace, right before Pengaturan: Pengaturan's sub-list opens
      // below Pengaturan, so this link never moves when that list opens or closes.
      // Its pages (/admin/settings/plugins and each plugin's page beneath it)
      // pass activeMenu="plugins"; management stays owner-only on the page and API.
      // Admin › Tema (2026-11-23): right above Plugin. The theme cards, and
      // under the active one its homepage (banner, sections, heading, accent).
      {
        id: "theme",
        href: "/admin/settings/theme",
        label: "Tema",
        description: "Tampilan toko dan beranda",
        icon: Palette,
        keywords: "tema theme tampilan toko beranda homepage banner warna aksen katalog pasar rapi klasik",
      },
      {
        id: "plugins",
        href: "/admin/settings/plugins",
        label: "Plugin",
        description: "Fitur opsional per toko",
        icon: Puzzle,
        keywords: "plugin ekstensi fitur opsional kelola crm",
      },
      {
        id: "settings",
        href: "/admin/settings",
        label: "Pengaturan",
        description: "Toko, gudang, dan akses",
        icon: Settings,
        keywords: "settings system store domain warehouse crm access headless developer api whatsapp wa cs rotator nomor langganan billing bayar paket perpanjang",
        // One list for the settings rail, the phone menu sheet and the search.
        children: SETTINGS_GROUPS.flatMap((group) => group.items)
          .filter((section) => section.href !== SETTINGS_INDEX)
          .map(({ href, label, icon }) => ({ href, label, icon })),
        sectionRail: true,
      },
    ],
  },
];

export const profileNavItem: AdminNavItem = {
  id: "profile",
  href: "/admin/profile",
  label: "Profil & integrasi",
  shortLabel: "Profil",
  description: "Akun, keamanan, dan API",
  icon: CircleUserRound,
  keywords: "profile akun password mengantar autolaris api domain",
};

/** Off the sidebar on purpose: the status icon beside the bell is its entry
 *  (PRD A39); the command palette finds it for owner and admin. */
export const statusNavItem: AdminNavItem = {
  id: "status",
  href: "/admin/status",
  label: "Status operasional",
  description: "Kesehatan sinyal dan setup toko",
  icon: Activity,
  keywords: "status kesehatan health setup operasional cron capi alert",
};

/** Menu items whose sub-pages are the item itself: each plugin's settings page
 *  lives under the plugin list (ADR-028). Every other item matches exactly. */
const NESTED_NAV_HREFS = new Set(["/admin/settings/plugins", "/admin/settings/theme"]);

export function isAdminNavHrefActive(currentPath: string, href: string) {
  const base = "https://admin.local";
  const current = new URL(currentPath, base);
  const target = new URL(href, base);
  if (NESTED_NAV_HREFS.has(target.pathname) && current.pathname.startsWith(`${target.pathname}/`)) return true;
  if (current.pathname !== target.pathname) return false;
  for (const [key, value] of target.searchParams) {
    if (current.searchParams.get(key) !== value) return false;
  }
  return true;
}

/**
 * DIGITAL-PRODUCTS-SPEC §4.1: a digital store ships nothing, so its menu has no
 * shipping, couriers, rate check or warehouse. Hidden, not removed: the pages
 * still answer, and switching the mode back restores the menu as it was.
 */
const SHIPPING_ITEM_IDS = new Set(["shipping", "expeditions", "scoring"]);
const SHIPPING_CHILD_HREFS = new Set(["/admin/settings/warehouse"]);

export type CatalogMode = "physical" | "digital" | "hybrid";

function forCatalog(groups: AdminNavGroup[], catalogMode: CatalogMode): AdminNavGroup[] {
  if (catalogMode !== "digital") return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => !SHIPPING_ITEM_IDS.has(item.id))
        .map((item) => item.children ? { ...item, children: item.children.filter((child) => !SHIPPING_CHILD_HREFS.has(child.href)) } : item),
    }))
    .filter((group) => group.items.length > 0);
}

export function getVisibleNavGroups(role: AdminRole, catalogMode: CatalogMode = "hybrid") {
  return forCatalog(navGroupsForRole(role), catalogMode);
}

function navGroupsForRole(role: AdminRole) {
  if (role === "owner") return adminNavGroups;
  const visibleIds = role === "admin"
    ? new Set(adminNavGroups.flatMap((group) => group.items.map((item) => item.id)))
    : role === "advertiser"
      // "content" was here too, but no group defines that id any more - the page is
      // deliberately off the menu and reached from Pengaturan > Toko.
      ? new Set(["dashboard", "products", "analytics", "ads"])
      : new Set(["dashboard", "orders", "shipping", "scoring"]);
  return adminNavGroups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => visibleIds.has(item.id))
        .map((item) => role === "admin" && item.id === "settings"
          ? {
              ...item,
              children: item.children?.filter(
                (child) => child.href !== "/admin/settings/access",
              ),
            }
          : item),
    }))
    .filter((group) => group.items.length > 0);
}

export function getSearchableNavItems(role: AdminRole, catalogMode: CatalogMode = "hybrid") {
  const groups = getVisibleNavGroups(role, catalogMode);
  return [
    ...groups.flatMap((group) =>
      group.items.flatMap((item) => [
        { ...item, group: group.label },
        ...(item.children ?? []).map((child) => ({
          ...item,
          href: child.href,
          label: child.label,
          description: item.label,
          icon: child.icon ?? item.icon,
          group: group.label,
        })),
      ]),
    ),
    ...(role === "owner" || role === "admin" ? [{ ...statusNavItem, group: "Akun" }] : []),
    { ...profileNavItem, group: "Akun" },
  ];
}
