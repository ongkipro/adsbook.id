import * as React from "react";
const NotificationPanel = React.lazy(() => import("./NotificationPanel").then((module) => ({ default: module.NotificationPanel })));
import { TOPBAR_BADGE, TOPBAR_ICON_BUTTON } from "./topbar-styles";
import { Bell } from "lucide-react";
import {
  isNotificationMuted,
  playNotificationChime,
  setNotificationMuted,
} from "@/lib/notification-chime";

export type NotificationType = "order" | "lead" | "payment";

export type NotificationItem = {
  id: number;
  type: NotificationType;
  order_number: string;
  title: string;
  body: string;
  created_at: string;
  href: string;
  unread: boolean;
};

const POLL_MS = 30_000;
/** Which events this browser has already raised a toast for (REQ-152). */
const SHOWN_KEY = "adsbookcms:notified:v1";
/** Set once the operator has been asked for notification permission. */
const PERMISSION_ASKED_KEY = "adsbookcms:notify-asked:v1";


function readShown(): number[] {
  try {
    const raw = window.localStorage.getItem(SHOWN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "number") : [];
  } catch {
    // A browser with storage disabled still gets the in-app list; it just
    // cannot remember what it already announced.
    return [];
  }
}

function rememberShown(ids: number[]) {
  try {
    // Bounded: only recent ids matter, and this must never grow without limit.
    window.localStorage.setItem(SHOWN_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    /* storage unavailable — announcing twice is better than failing */
  }
}


export function NotificationBell() {
  const [unread, setUnread] = React.useState(0);
  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [panelLoaded, setPanelLoaded] = React.useState(false);
  // Starts audible and is corrected from storage after mount: reading
  // localStorage while rendering would differ between server and client.
  const [muted, setMuted] = React.useState(false);

  React.useEffect(() => {
    setMuted(isNotificationMuted());
  }, []);

  const toggleMuted = React.useCallback(() => {
    setMuted((current) => {
      const next = !current;
      setNotificationMuted(next);
      // Unmuting is a user gesture, which is exactly what an autoplay-blocked
      // AudioContext needs: play once so the operator hears what they enabled
      // and the context is unlocked for the next order.
      if (!next) playNotificationChime();
      return next;
    });
  }, []);

  const announce = React.useCallback((list: NotificationItem[]) => {
    const shown = new Set(readShown());
    const fresh = list.filter((item) => item.unread && !shown.has(item.id));
    if (!fresh.length) return;

    // The chime is not gated on the Notification permission: an operator who
    // never granted desktop notifications — or who is on a tab where they are
    // unavailable — still needs to hear an order land.
    playNotificationChime();

    const mayNotify =
      typeof Notification !== "undefined" && Notification.permission === "granted";
    // Newest last so the most recent notification is the one left on screen.
    for (const item of fresh.slice(0, 5).reverse()) {
      if (mayNotify) {
        try {
          new Notification(item.title, { body: item.body, tag: `adsbook-${item.id}` });
        } catch {
          /* the browser refused it; the in-app list still has it */
        }
      }
    }
    // Every fresh id is recorded, not just the five that were surfaced:
    // `shown` means "already announced", and leaving the rest unmarked would
    // re-ring the chime on the next poll for as long as they stayed unread.
    for (const item of fresh) shown.add(item.id);
    rememberShown([...shown]);
  }, []);

  const load = React.useCallback(
    async (withList: boolean) => {
      try {
        const response = await fetch(
          `/api/admin/notifications${withList ? "" : "?count_only=true"}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
        // 403 is the advertiser role, not a fault: hide the bell and stop.
        if (response.status === 403) return "forbidden" as const;
        if (!response.ok) throw new Error("notifications unavailable");
        const payload = (await response.json()) as {
          unread?: number;
          notifications?: NotificationItem[];
        };
        setUnread(Number(payload.unread || 0));
        if (payload.notifications) {
          setItems(payload.notifications);
          announce(payload.notifications);
        }
        setFailed(false);
        return "ok" as const;
      } catch {
        setFailed(true);
        return "error" as const;
      }
    },
    [announce],
  );

  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const tick = async () => {
      // Polling, not SSE: an open stream would pin a Worker isolate per tab.
      const result = await load(true);
      // Also checked on every poll, not just at mount: a role downgraded
      // mid-session would otherwise keep polling a 403 forever.
      if (active && result === "forbidden") setHidden(true);
    };
    void tick();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  // Asked once per browser, not on every open. A dismissed prompt leaves
  // permission at "default", so re-requesting each time would nag the operator
  // until the browser auto-blocks the origin outright.
  const requestPermission = async () => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    try {
      if (window.localStorage.getItem(PERMISSION_ASKED_KEY)) return;
      window.localStorage.setItem(PERMISSION_ASKED_KEY, "1");
    } catch {
      // Storage unavailable: ask anyway rather than never asking.
    }
    await Notification.requestPermission();
  };

  const handleOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setLoading(true);
    await requestPermission();
    await load(true);
    setLoading(false);
  };

  const mutate = async (body: Record<string, unknown>) => {
    try {
      const response = await fetch("/api/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("update failed");
      setUnread(Number(((await response.json()) as { unread?: number }).unread || 0));
    } catch {
      setFailed(true);
    }
  };

  const markAllRead = async () => {
    setItems((current) => current.map((item) => ({ ...item, unread: false })));
    await mutate({ action: "read-all" });
  };

  const openItem = async (item: NotificationItem) => {
    if (item.unread) {
      setItems((current) =>
        current.map((row) => (row.id === item.id ? { ...row, unread: false } : row)),
      );
      await mutate({ action: "read", id: item.id });
    }
    window.location.assign(item.href);
  };

  if (hidden) return null;

  const badge = unread > 99 ? "99+" : String(unread);

  // The panel (and the menu code behind it) loads on the first click; the
  // badge and polling above are here from the start. Until it has loaded a
  // plain button with the same face stands in.
  if (!panelLoaded) {
    return (
      <button
        type="button"
        className={TOPBAR_ICON_BUTTON}
        aria-label={unread > 0 ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}
        aria-haspopup="menu"
        aria-expanded={false}
        onClick={() => {
          setPanelLoaded(true);
          void handleOpenChange(true);
        }}
      >
        <Bell className="size-[18px]" aria-hidden="true" />
        {unread > 0 && (
          <span className={`${TOPBAR_BADGE} bg-red-600`}>
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <React.Suspense fallback={null}>
      <NotificationPanel
        open={open}
        onOpenChange={handleOpenChange}
        triggerLabel={unread > 0 ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}
        unread={unread}
        badge={badge}
        items={items}
        loading={loading}
        failed={failed}
        muted={muted}
        onMarkAllRead={markAllRead}
        onToggleMuted={toggleMuted}
        onOpenItem={openItem}
      />
    </React.Suspense>
  );
}
