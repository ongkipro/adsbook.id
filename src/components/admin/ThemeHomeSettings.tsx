import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type Settings = {
  sections: { banner: boolean; trustStrip: boolean };
  catalog: { title: string; description: string };
};
type ThemeData = { active: string; accent: string; settings: Settings };

/** Ready-made accents that pass UI-2 (white text ≥ 4.5:1), for a seller who does not know hex. */
const SWATCHES = ["#2563EB", "#0F766E", "#15803D", "#B91C1C", "#C2410C", "#7C3AED", "#BE185D", "#111827"];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * /admin/settings/theme/beranda: the active theme's homepage — sections on or
 * off, the catalogue heading and the accent colour. One save, validated in
 * full on the server; the banner has its own editor above this one.
 */
export function ThemeHomeSettings() {
  const [data, setData] = useState<ThemeData | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [accent, setAccent] = useState("#2563EB");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings/theme", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal memuat pengaturan beranda.");
        setData(payload.data);
        setAccent(payload.data.accent);
        setSettings(payload.data.settings);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Gagal memuat pengaturan beranda."));
  }, []);

  const save = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/settings/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", accent, settings }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal menyimpan.");
      setData(payload.data);
      setAccent(payload.data.accent);
      setSettings(payload.data.settings);
      toast.success(payload.message || "Tersimpan.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal menyimpan.");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800" role="alert">{error}</div>;
  if (!data || !settings) {
    return (
      <div className="h-72 animate-pulse rounded-xl bg-slate-100" role="status" aria-busy="true">
        <span className="sr-only">Memuat pengaturan beranda.</span>
      </div>
    );
  }

  const toggle = (key: keyof Settings["sections"], label: string, hint: string) => (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={`theme-${key}-label`} className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="mt-0.5 text-sm text-slate-500">{hint}</p>
      </div>
      <Switch
        aria-labelledby={`theme-${key}-label`}
        checked={settings.sections[key]}
        onCheckedChange={(checked) => setSettings({ ...settings, sections: { ...settings.sections, [key]: Boolean(checked) } })}
      />
    </div>
  );

  return (
    <form onSubmit={save} className="space-y-5" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Bagian beranda</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-slate-100">
          {toggle("banner", "Banner", "Banner di atas beranda. Tanpa banner, beranda langsung dibuka dengan produk.")}
          {toggle("trustStrip", "Strip kepercayaan", "COD, metode bayar, dan kurir, diambil dari pengaturan checkout toko.")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Judul katalog</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-slate-900">Judul</span>
            <Input
              value={settings.catalog.title}
              maxLength={60}
              required
              onChange={(event) => setSettings({ ...settings, catalog: { ...settings.catalog, title: event.target.value } })}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-slate-900">Deskripsi <span className="font-normal text-slate-500">(opsional)</span></span>
            <Input
              value={settings.catalog.description}
              maxLength={160}
              onChange={(event) => setSettings({ ...settings, catalog: { ...settings.catalog, description: event.target.value } })}
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Warna aksen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-500">Dipakai untuk tombol, tautan, dan pilihan di toko. Warna yang terlalu terang untuk tulisan putih ditolak supaya tombol tetap terbaca.</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pilihan warna">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={accent.toUpperCase() === swatch}
                aria-label={swatch}
                onClick={() => setAccent(swatch)}
                className="grid size-11 place-items-center rounded-lg border border-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 aria-checked:border-slate-900 aria-checked:ring-2 aria-checked:ring-slate-900/15"
              >
                <span className="size-7 rounded-md" style={{ background: swatch }} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-slate-900">Kode warna</span>
              <Input value={accent} maxLength={7} spellCheck={false} className="w-36 font-mono" onChange={(event) => setAccent(event.target.value.trim())} />
            </label>
            <div className="flex items-center gap-3 pb-1">
              <span
                className="inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold text-white"
                style={{ background: HEX.test(accent) ? accent : "#94A3B8" }}
                aria-hidden="true"
              >
                Beli sekarang
              </span>
              <span className="text-xs text-slate-500">Pratinjau tombol</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>{saving ? "Menyimpan…" : "Simpan & terapkan"}</Button>
        <a href="/" target="_blank" rel="noopener" className="text-sm font-semibold text-blue-700 underline underline-offset-2">Lihat toko</a>
      </div>
    </form>
  );
}
