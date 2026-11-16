import type { LucideIcon } from "lucide-react";
import { Activity, Globe, HeartPulse, LayoutDashboard, ReceiptText, Store, UsersRound } from "lucide-react";
import type { PlatformRole } from "../../platform/admin/session";

/**
 * The platform console's menu (T-52, docs/design/platform-admin/DESIGN.md §5),
 * shaped like the seller admin's `admin-navigation.ts` so the two shells read
 * the same. Grouped by the operator's job; Tim is platform_owner only.
 */
export type PlatformMenu = "overview" | "tenants" | "domains" | "billing" | "health" | "activity" | "team";

export type PlatformNavItem = {
  id: PlatformMenu;
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  keywords: string;
  ownerOnly?: boolean;
};

export type PlatformNavGroup = { label: string; items: PlatformNavItem[] };

export const platformNavGroups: PlatformNavGroup[] = [
  {
    label: "Bisnis",
    items: [
      { id: "overview", href: "/platform", label: "Ringkasan", description: "Pendapatan, toko berbayar, dan yang perlu ditindak", icon: LayoutDashboard, keywords: "ringkasan dashboard mrr pendapatan konversi preview follow up" },
      { id: "billing", href: "/platform/billing", label: "Tagihan", description: "Invoice langganan dan kalender perpanjangan", icon: ReceiptText, keywords: "tagihan invoice langganan bayar qris va perpanjang masa tenggang" },
    ],
  },
  {
    label: "Toko",
    items: [
      { id: "tenants", href: "/platform/tenants", label: "Toko", description: "Semua toko, status, dan langganannya", icon: Store, keywords: "toko tenant seller owner slug suspend" },
      { id: "domains", href: "/platform/domains", label: "Domain", description: "Domain sendiri milik seller", icon: Globe, keywords: "domain custom hostname ssl dns" },
    ],
  },
  {
    label: "Sistem",
    items: [
      { id: "health", href: "/platform/health", label: "Kesehatan", description: "Heartbeat, backlog, dan konfigurasi platform", icon: HeartPulse, keywords: "kesehatan heartbeat backlog recovery konfigurasi" },
      { id: "activity", href: "/platform/activity", label: "Aktivitas", description: "Log audit semua toko dan platform", icon: Activity, keywords: "aktivitas audit log riwayat event" },
      { id: "team", href: "/platform/team", label: "Tim", description: "Siapa yang bisa masuk ke console ini", icon: UsersRound, keywords: "tim user pengguna akses totp owner support", ownerOnly: true },
    ],
  },
];

export function getVisiblePlatformGroups(role: PlatformRole): PlatformNavGroup[] {
  return platformNavGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.ownerOnly || role === "platform_owner") }))
    .filter((group) => group.items.length > 0);
}

export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = { platform_owner: "Owner platform", platform_support: "Support platform" };
