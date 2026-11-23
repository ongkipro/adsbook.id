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
  preview: "wide" | "column";
};

/** The two built-in themes (storefront-template.ts), described for a seller. */
const THEMES: ThemeCard[] = [
  {
    id: "pasar-rapi",
    name: "Pasar Rapi",
    summary: "Tampilan default. Lebar penuh di desktop, seperti marketplace.",
    points: ["Header dengan kolom cari", "Grid 2–5 kolom, kartu ringkas", "Halaman produk 2 kolom di desktop"],
    preview: "wide",
  },
  {
    id: "compact-market",
    name: "Klasik",
    summary: "Satu kolom selebar ponsel di semua layar.",
    points: ["Cocok untuk 1–5 produk", "Terasa seperti landing page", "Form pesan selalu di tengah"],
    preview: "column",
  },
];

/** A drawn sketch of the layout, in the store's accent: no screenshot to go stale. */
function Preview({ kind, accent }: { kind: ThemeCard["preview"]; accent: string }) {
  const tile = (x: number, y: number, w: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height={w} rx="2" fill="#E2E8F0" />
      <rect x={x} y={y + w + 3} width={w * 0.8} height="3" rx="1.5" fill="#CBD5E1" />
      <rect x={x} y={y + w + 9} width={w * 0.5} height="4" rx="1.5" fill="#0F172A" />
    </g>
  );
  if (kind === "wide") {
    return (
      <svg viewBox="0 0 240 150" className="h-full w-full" aria-hidden="true">
        <rect width="240" height="150" fill="#F8FAFC" />
        <rect x="0" y="0" width="240" height="16" fill="#fff" />
        <rect x="12" y="5" width="26" height="6" rx="1.5" fill="#0F172A" />
        <rect x="46" y="4" width="120" height="8" rx="2" fill="#F1F5F9" stroke="#E2E8F0" />
        <rect x="12" y="22" width="216" height="34" rx="3" fill="#fff" stroke="#E2E8F0" />
        <rect x="12" y="22" width="120" height="34" rx="3" fill="#E2E8F0" />
        <rect x="142" y="33" width="60" height="6" rx="1.5" fill="#0F172A" />
        <rect x="12" y="61" width="216" height="8" rx="2" fill="#fff" stroke="#E2E8F0" />
        <rect x="16" y="63.5" width="4" height="3" rx="1" fill={accent} />
        <rect x="88" y="63.5" width="4" height="3" rx="1" fill={accent} />
        <rect x="160" y="63.5" width="4" height="3" rx="1" fill={accent} />
        {[0, 1, 2, 3, 4].map((index) => tile(12 + index * 44, 76, 40))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 240 150" className="h-full w-full" aria-hidden="true">
      <rect width="240" height="150" fill="#E2E8F0" />
      <rect x="80" y="0" width="80" height="150" fill="#fff" />
      <rect x="92" y="5" width="34" height="6" rx="1.5" fill="#0F172A" />
      <rect x="86" y="16" width="68" height="44" rx="3" fill="#E2E8F0" />
      <rect x="86" y="64" width="68" height="18" rx="2" fill="#fff" stroke="#E2E8F0" />
      <rect x="90" y="68" width="4" height="3" rx="1" fill={accent} />
      <rect x="90" y="75" width="4" height="3" rx="1" fill={accent} />
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
          const active = !state.custom && state.active === theme.id;
          return (
            <li
              key={theme.id}
              data-theme-card={theme.id}
              className={`flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm ${active ? "border-blue-600 ring-1 ring-blue-600" : "border-slate-200"}`}
            >
              <div className="aspect-[8/5] border-b border-slate-100 bg-slate-50">
                <Preview kind={theme.preview} accent={state.accent} />
              </div>
              <div className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-950">{theme.name}</h2>
                  {active ? <Badge>Aktif</Badge> : <Badge variant="outline">Tersedia</Badge>}
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
                  {active ? (
                    <a href="/admin/settings/theme/beranda" className={buttonVariants({ variant: "default" })}>
                      Atur beranda
                    </a>
                  ) : (
                    <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void activate(theme)}>
                      {pending === theme.id ? "Mengaktifkan…" : "Pakai tema ini"}
                    </Button>
                  )}
                  <a href="/" target="_blank" rel="noopener" className={buttonVariants({ variant: "ghost" })}>
                    Lihat toko
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
