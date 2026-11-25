import type { LucideIcon } from "lucide-react";
import {
  CircleUserRound,
  CodeXml,
  CreditCard,
  FilePenLine,
  Globe,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  ShieldCheck,
  ShoppingBag,
  Warehouse,
} from "lucide-react";
import { canAccessAdminRoute, type AdminRole } from "../../lib/auth.ts";
import type { CatalogMode } from "./admin-navigation";

/**
 * Pengaturan's own menu: the rail beside every settings page at 1280px and up,
 * and the directory on `/admin/settings` on a phone. One list, so a page added
 * here appears in both, in the phone menu sheet and in the Ctrl+K search
 * (admin-navigation.ts derives Pengaturan's children from it). The desktop
 * sidebar shows Pengaturan as one item and leaves the sections to this rail.
 */
export type SettingsSection = { href: string; label: string; hint: string; icon: LucideIcon };
export type SettingsGroup = { label: string; items: SettingsSection[] };

export const SETTINGS_INDEX = "/admin/settings";

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Toko",
    items: [
      { href: SETTINGS_INDEX, label: "Ringkasan", hint: "Status integrasi", icon: LayoutGrid },
      { href: "/admin/setup", label: "Checklist setup", hint: "Langkah agar toko siap", icon: ListChecks },
      { href: "/admin/settings/store", label: "Toko & CS", hint: "Identitas dan kontak", icon: ShoppingBag },
      { href: "/admin/settings/domains", label: "Domain", hint: "Alamat toko Anda", icon: Globe },
      { href: "/admin/billing", label: "Langganan", hint: "Paket dan tagihan", icon: CreditCard },
    ],
  },
  {
    label: "Operasional",
    items: [
      { href: "/admin/settings/whatsapp", label: "Nomor WhatsApp CS", hint: "Penerima pembeli COD", icon: MessageCircle },
      { href: "/admin/settings/warehouse", label: "Gudang & pickup", hint: "Asal kirim dan PIC", icon: Warehouse },
      { href: "/admin/settings/crm", label: "Template CRM", hint: "Pesan WhatsApp ke pembeli", icon: FilePenLine },
      { href: "/admin/settings/privacy", label: "Kebijakan privasi", hint: "Teks tambahan toko", icon: ShieldCheck },
    ],
  },
  {
    label: "Akses & integrasi",
    items: [
      { href: "/admin/settings/access", label: "Akses pengguna", hint: "Akun operator dan peran", icon: CircleUserRound },
      { href: "/admin/settings/developer", label: "Headless API", hint: "API key dan domain", icon: CodeXml },
    ],
  },
];

/** A digital store ships nothing (DIGITAL-PRODUCTS-SPEC §4.1). */
const SHIPPING_HREFS = new Set(["/admin/settings/warehouse"]);

/** The sections this role may open, for this store's catalogue mode. Empty groups are dropped. */
export function visibleSettingsGroups(role: AdminRole, catalogMode: CatalogMode = "hybrid"): SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => canAccessAdminRoute(role, item.href) && !(catalogMode === "digital" && SHIPPING_HREFS.has(item.href)),
    ),
  })).filter((group) => group.items.length > 0);
}
