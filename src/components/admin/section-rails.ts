import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  ChartNoAxesCombined,
  Clock3,
  CreditCard,
  FilePenLine,
  Globe,
  LayoutGrid,
  Link2,
  MapPin,
  Megaphone,
  Package,
  Share2,
  Tag,
} from "lucide-react";
import { canAccessAdminRoute, type AdminRole } from "../../lib/auth.ts";

export type RailSection = {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
};

export type RailGroup = {
  label?: string;
  items: RailSection[];
};

export const ANALYTICS_RAIL_GROUPS: RailGroup[] = [
  {
    label: "Laporan",
    items: [
      { href: "/admin/analytics", label: "Ringkasan", hint: "Tren order & omset", icon: ChartNoAxesCombined },
      { href: "/admin/analytics/landing", label: "Landing page", hint: "Performa per halaman", icon: FilePenLine },
      { href: "/admin/analytics/products", label: "Produk", hint: "Produk & varian terlaris", icon: Package },
      { href: "/admin/analytics/locations", label: "Lokasi", hint: "Provinsi & kota pembeli", icon: MapPin },
      { href: "/admin/analytics/times", label: "Waktu beli", hint: "Jam & hari ramai", icon: Clock3 },
      { href: "/admin/analytics/utm", label: "UTM", hint: "Sumber & kampanye iklan", icon: Tag },
    ],
  },
];

export const ADS_RAIL_GROUPS: RailGroup[] = [
  {
    label: "Channel",
    items: [
      { href: "/admin/ads", label: "Ringkasan", hint: "Status semua channel", icon: LayoutGrid },
      { href: "/admin/ads/meta", label: "Meta Pixel & CAPI", hint: "Browser pixel & server event", icon: Megaphone },
      { href: "/admin/ads/google", label: "Google Ads", hint: "GTM, conversion & offline", icon: Globe },
      { href: "/admin/ads/tiktok", label: "TikTok Ads", hint: "Pixel & Events API", icon: Share2 },
    ],
  },
  {
    label: "Alat",
    items: [
      { href: "/admin/ads/utm", label: "Link UTM", hint: "Buat tautan kampanye", icon: Link2 },
    ],
  },
];

export const PAYMENTS_RAIL_GROUPS: RailGroup[] = [
  {
    label: "Pembayaran",
    items: [
      { href: "/admin/payments", label: "Metode pembayaran", hint: "COD, AutoLaris, biaya, rekening", icon: CreditCard },
      { href: "/admin/balance", label: "Rekonsiliasi", hint: "Verifikasi QRIS & VA", icon: BadgeDollarSign },
    ],
  },
];

export function visibleRailGroups(groups: RailGroup[], role: AdminRole): RailGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessAdminRoute(role, item.href)),
    }))
    .filter((group) => group.items.length > 0);
}
