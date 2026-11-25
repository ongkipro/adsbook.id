import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  Boxes,
  ChartNoAxesCombined,
  Clock3,
  CreditCard,
  FilePenLine,
  Globe,
  Landmark,
  LayoutGrid,
  Link2,
  MapPin,
  MapPinOff,
  Megaphone,
  MessageCircle,
  Package,
  PackageSearch,
  Percent,
  Share2,
  SlidersHorizontal,
  Tag,
  Truck,
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

export const EXPEDITIONS_RAIL_GROUPS: RailGroup[] = [
  {
    label: "Ekspedisi",
    items: [
      { href: "/admin/expeditions", label: "Daftar ekspedisi", hint: "Kurir aktif & layanan COD", icon: Boxes },
      { href: "/admin/expeditions/cod-policy", label: "Kebijakan provinsi", hint: "Wilayah tanpa pembayaran COD", icon: MapPinOff },
    ],
  },
];

export const CHECK_RAIL_GROUPS: RailGroup[] = [
  {
    label: "Pengecekan",
    items: [
      { href: "/admin/check", label: "Cek WA (RTS)", hint: "Riwayat terkirim & retur pembeli", icon: MessageCircle },
      { href: "/admin/check/ongkir", label: "Cek ongkir", hint: "Bandingkan tarif & estimasi kurir", icon: Truck },
      { href: "/admin/check/resi", label: "Cek resi", hint: "Lacak status & riwayat paket", icon: PackageSearch },
    ],
  },
];

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
    label: "Pengaturan",
    items: [
      { href: "/admin/payments", label: "Metode pembayaran", hint: "COD, transfer manual & AutoLaris", icon: CreditCard },
      { href: "/admin/payments/channels", label: "Channel AutoLaris", hint: "QRIS & Virtual Account di checkout", icon: SlidersHorizontal },
      { href: "/admin/payments/fees", label: "Biaya transaksi", hint: "Penanggung fee online & COD", icon: Percent },
      { href: "/admin/payments/banks", label: "Rekening bank", hint: "Rekening transfer manual toko", icon: Landmark },
    ],
  },
  {
    label: "Verifikasi",
    items: [
      { href: "/admin/balance", label: "Rekonsiliasi", hint: "Verifikasi QRIS & VA masuk", icon: BadgeDollarSign },
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
