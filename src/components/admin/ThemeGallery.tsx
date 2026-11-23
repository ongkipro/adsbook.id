import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

type ThemeState = { active: string; custom: boolean; accent: string };

type ThemeCard = {
  id: string;
  name: string;
  summary: string;
  points: string[];
  /** Not selectable yet: shown so a seller knows more 480px themes are coming. */
  soon?: boolean;
};

/**
 * Every storefront theme is the 480px column (owner, 2026-11-23: an ad tapped
 * on a phone lands on a COD form). "Compact" is the one built-in theme
 * (storefront-template.ts); the second card announces the next one.
 */
const THEMES: ThemeCard[] = [
  {
    id: "compact-market",
    name: "Compact",
    summary: "Satu kolom 480px, dibuat untuk pembeli dari iklan di ponsel.",
    points: ["Header dengan kolom cari", "Kartu produk ringkas, 2 kolom", "Form pesan COD di halaman produk"],
  },
  {
    id: "soon",
    name: "Tema berikutnya",
    summary: "Variasi tampilan 480px lain sedang disiapkan.",
    points: ["Tetap satu kolom untuk ponsel", "Bisa diganti tanpa mengubah produk"],
    soon: true,
  },
];

/** A drawn sketch of the column, in the store's accent: no screenshot to go stale. */
function Preview({ accent, muted }: { accent: string; muted?: boolean }) {
  const ink = muted ? "#CBD5E1" : "#0F172A";
  const dot = muted ? "#CBD5E1" : accent;
  const tile = (x: number, y: number, w: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height={w} rx="2" fill="#E2E8F0" />
      <rect x={x} y={y + w + 3} width={w * 0.8} height="3" rx="1.5" fill="#CBD5E1" />
      <rect x={x} y={y + w + 9} width={w * 0.5} height="4" rx="1.5" fill={ink} />
    </g>
  );
  return (
    <svg viewBox="0 0 240 150" className="h-full w-full" aria-hidden="true">
      <rect width="240" height="150" fill="#E2E8F0" />
      <rect x="80" y="0" width="80" height="150" fill="#fff" />
      <rect x="86" y="5" width="22" height="6" rx="1.5" fill={ink} />
      <rect x="112" y="4" width="42" height="8" rx="2" fill="#F1F5F9" stroke="#E2E8F0" />
      <rect x="86" y="16" width="68" height="44" rx="2" fill="#E2E8F0" />
      <rect x="86" y="64" width="68" height="18" rx="2" fill="#fff" stroke="#E2E8F0" />
      <rect x="90" y="68" width="4" height="3" rx="1" fill={dot} />
      <rect x="90" y="75" width="4" height="3" rx="1" fill={dot} />
      {tile(86, 88, 32)}
      {tile(122, 88, 32)}
    </svg>
  );
}

/**
 * /admin/settings/theme: the theme cards. The active one opens its homepage
 * configuration; the other can be activated. Owner and admin (auth.ts).
 */
export function ThemeGallery() {
  const [state, setState] = useState<ThemeState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings/theme", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal memuat tema.");
        setState(payload.data);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Gagal memuat tema."));
  }, []);

  const activate = async (theme: ThemeCard) => {
    setPending(theme.id);
    try {
      const response = await fetch("/api/admin/settings/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", theme: theme.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal mengganti tema.");
      setState(payload.data);
      toast.success(payload.message || `Tema ${theme.name} aktif.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal mengganti tema.");
    } finally {
      setPending(null);
    }
  };

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800" role="alert">{error}</div>;
  if (!state) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" role="status" aria-busy="true">
        <div className="h-80 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-80 animate-pulse rounded-xl bg-slate-100" />
        <span className="sr-only">Memuat tema.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.custom && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Toko ini memakai template khusus dari Pengaturan › Toko. Mengaktifkan salah satu tema di bawah menggantikannya.
        </p>
      )}
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-label="Tema toko">
        {THEMES.map((theme) => {
          const active = !theme.soon && !state.custom && state.active === theme.id;
          return (
            <li
              key={theme.id}
              data-theme-card={theme.id}
              aria-disabled={theme.soon || undefined}
              className={`flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm ${active ? "border-blue-600 ring-1 ring-blue-600" : "border-slate-200"} ${theme.soon ? "opacity-70" : ""}`}
            >
              <div className="aspect-[8/5] border-b border-slate-100 bg-slate-50">
                <Preview accent={state.accent} muted={theme.soon} />
              </div>
              <div className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-950">{theme.name}</h2>
                  {active ? <Badge>Aktif</Badge> : <Badge variant="outline">{theme.soon ? "Segera hadir" : "Tersedia"}</Badge>}
                </div>
                <p className="text-sm text-slate-600">{theme.summary}</p>
                <ul className="space-y-1.5 text-sm text-slate-700">
                  {theme.points.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-blue-600" aria-hidden="true" />
                      {point}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex flex-wrap gap-2 pt-2">
                  {theme.soon ? null : active ? (
                    <a href="/admin/settings/theme/beranda" className={buttonVariants({ variant: "default" })}>
                      Atur beranda
                    </a>
                  ) : (
                    <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void activate(theme)}>
                      {pending === theme.id ? "Mengaktifkan…" : "Pakai tema ini"}
                    </Button>
                  )}
                  {!theme.soon && (
                    <a href="/" target="_blank" rel="noopener" className={buttonVariants({ variant: "ghost" })}>
                      Lihat toko
                    </a>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
