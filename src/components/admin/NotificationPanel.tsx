import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bell, PackagePlus, UserPlus, Volume2, VolumeX, Wallet } from "lucide-react";
import { TOPBAR_BADGE, TOPBAR_ICON_BUTTON } from "./topbar-styles";
import type { NotificationItem, NotificationType } from "./NotificationBell";

const ICONS: Record<NotificationType, typeof Bell> = {
  order: PackagePlus,
  lead: UserPlus,
  payment: Wallet,
};

function relativeTime(iso: string) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

/**
 * The notification dropdown. NotificationBell keeps the polling, the badge,
 * the chime and the actions, and loads this panel on the first click, so the
 * menu code is not in every admin page's first download. Mounted open.
 */
export function NotificationPanel({
  open,
  onOpenChange,
  triggerLabel,
  unread,
  badge,
  items,
  loading,
  failed,
  muted,
  onMarkAllRead,
  onToggleMuted,
  onOpenItem,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel: string;
  unread: number;
  badge: string;
  items: NotificationItem[];
  loading: boolean;
  failed: boolean;
  muted: boolean;
  onMarkAllRead: () => void;
  onToggleMuted: () => void;
  onOpenItem: (item: NotificationItem) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={<button
          type="button"
          className={`${TOPBAR_ICON_BUTTON} data-popup-open:bg-slate-100 data-popup-open:text-slate-900`}
          aria-label={triggerLabel} />}>
          <Bell className="size-[18px]" aria-hidden="true" />
          {unread > 0 && (
            <span className={`${TOPBAR_BADGE} bg-red-600`}>
              {badge}
            </span>
          )}
        </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(22rem,calc(100vw-1.5rem))] p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
          <p className="text-xs font-semibold text-slate-900">Notifikasi</p>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={onMarkAllRead}
                className="rounded-lg px-2 py-1 text-xs font-semibold text-blue-600 transition hover:bg-blue-50"
              >
                Tandai semua dibaca
              </button>
            )}
            <button
              type="button"
              onClick={onToggleMuted}
              aria-pressed={muted}
              title={muted ? "Bunyikan notifikasi" : "Bisukan notifikasi"}
              aria-label={muted ? "Bunyikan notifikasi" : "Bisukan notifikasi"}
              className="grid size-7 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            >
              {muted ? (
                <VolumeX className="size-4" aria-hidden="true" />
              ) : (
                <Volume2 className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        <div className="max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain">
          {loading && items.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-500">Memuat…</p>
          )}
          {!loading && failed && items.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              Notifikasi gagal dimuat. Coba buka lagi sebentar.
            </p>
          )}
          {!loading && !failed && items.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              Belum ada order, lead, atau pembayaran baru.
            </p>
          )}
          {items.map((item) => {
            const Icon = ICONS[item.type] ?? Bell;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenItem(item)}
                className={`flex w-full items-start gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-slate-50 ${
                  item.unread ? "bg-blue-50/40" : ""
                }`}
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-900">
                      {item.title}
                    </span>
                    {item.unread && (
                      <span className="size-1.5 shrink-0 rounded-full bg-blue-600" aria-hidden="true" />
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-600">
                    {item.body}
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-slate-400">
                    {relativeTime(item.created_at)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
