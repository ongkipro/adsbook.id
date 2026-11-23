import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Eye, Lock } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type CatalogSort, type HomeSectionId, type StoreThemeSettings } from "../../lib/storefront-theme";

type ThemeData = { active: string; accent: string; settings: StoreThemeSettings };
type ProductOption = { id: string; title: string; image: string | null; active: boolean };

/** Ready-made accents that pass UI-2 (white text ≥ 4.5:1), for a seller who does not know hex. */
const SWATCHES = ["#2563EB", "#0F766E", "#15803D", "#B91C1C", "#C2410C", "#7C3AED", "#BE185D", "#111827"];
const HEX = /^#[0-9a-fA-F]{6}$/;

const SECTION_META: Record<HomeSectionId, { title: string; hint: string }> = {
  announcement: { title: "Pengumuman", hint: "Satu baris di paling atas: promo, info ongkir, jam operasional." },
  hero: { title: "Hero", hint: "Slide besar di atas: banner Anda atau 3–5 produk." },
  trust: { title: "Strip kepercayaan", hint: "COD, metode bayar, dan kurir, dari pengaturan checkout toko." },
  featured: { title: "Pilihan kami", hint: "2–6 produk yang ingin Anda tonjolkan, digeser ke samping." },
  catalog: { title: "Katalog", hint: "Semua produk aktif dengan pencarian. Selalu tampil." },
  howToOrder: { title: "Cara pesan", hint: "Tiga langkah pesan, ditulis dari metode bayar toko Anda." },
};

const SORT_LABELS: Record<CatalogSort, string> = {
  newest: "Terbaru",
  bestselling: "Terlaris",
  price_asc: "Harga terendah",
  price_desc: "Harga tertinggi",
};

const HERO_SOURCES = [
  { value: "auto", label: "Otomatis", hint: "Banner Anda bila ada; kalau tidak, 3–5 produk yang berganti tiap hari." },
  { value: "products", label: "Pilih produk", hint: "Produk yang Anda pilih, sesuai urutan." },
  { value: "banner", label: "Banner", hint: "Hanya banner yang Anda unggah di atas." },
] as const;

const encode = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Admin › Tema › Atur beranda (owner, 2026-11-23): the homepage as an ordered
 * list of sections, each on or off with its own settings, beside a live
 * preview of the 480px storefront. Nothing reaches buyers until "Simpan";
 * the server validates the whole document again (storefront-theme.ts).
 */
export function ThemeHomeSettings() {
  const [data, setData] = useState<ThemeData | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [accent, setAccent] = useState("#2563EB");
  const [settings, setSettings] = useState<StoreThemeSettings | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [open, setOpen] = useState<HomeSectionId | null>(null);
  const [previewSrc, setPreviewSrc] = useState("");
  const savedRef = useRef("");

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/settings/theme", { headers: { Accept: "application/json" } }).then((response) => response.json().then((payload) => ({ response, payload }))),
      fetch("/api/admin/products?limit=200", { headers: { Accept: "application/json" } }).then((response) => response.json()).catch(() => null),
    ])
      .then(([theme, list]) => {
        if (!theme.response.ok || !theme.payload.success) throw new Error(theme.payload.error || "Gagal memuat pengaturan beranda.");
        setData(theme.payload.data);
        setAccent(theme.payload.data.accent);
        setSettings(theme.payload.data.settings);
        savedRef.current = JSON.stringify([theme.payload.data.accent, theme.payload.data.settings]);
        const rows = (list?.data?.products ?? list?.data ?? []) as Array<{ id: number | string; title: string; image_url: string | null; is_active: boolean | number }>;
        setProducts(rows.map((row) => ({ id: String(row.id), title: row.title, image: row.image_url, active: Boolean(row.is_active) })));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Gagal memuat pengaturan beranda."));
  }, []);

  const dirty = settings ? JSON.stringify([accent, settings]) !== savedRef.current : false;

  // The preview follows the form, debounced so typing does not reload the frame per key.
  useEffect(() => {
    if (!settings) return;
    const timer = window.setTimeout(() => {
      setPreviewSrc(`/?preview=home&s=${encode(settings)}${HEX.test(accent) ? `&accent=${encodeURIComponent(accent)}` : ""}`);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings, accent]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const activeProducts = useMemo(() => products.filter((product) => product.active), [products]);

  if (error) return <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">{error}</div>;
  if (!data || !settings) {
    return (
      <div className="h-96 animate-pulse rounded-xl bg-muted" role="status" aria-busy="true">
        <span className="sr-only">Memuat pengaturan beranda.</span>
      </div>
    );
  }

  const set = <K extends HomeSectionId>(id: K, patch: Partial<StoreThemeSettings["sections"][K]>) =>
    setSettings({ ...settings, sections: { ...settings.sections, [id]: { ...settings.sections[id], ...patch } } });

  const move = (id: HomeSectionId, step: -1 | 1) => {
    const order = [...settings.order];
    const from = order.indexOf(id);
    const to = from + step;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    setSettings({ ...settings, order });
  };

  const save = async () => {
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
      savedRef.current = JSON.stringify([payload.data.accent, payload.data.settings]);
      toast.success(payload.message || "Tersimpan.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal menyimpan.");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    const [savedAccent, savedSettings] = JSON.parse(savedRef.current) as [string, StoreThemeSettings];
    setAccent(savedAccent);
    setSettings(savedSettings);
  };

  const enabled = (id: HomeSectionId) => settings.sections[id].enabled;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Bagian beranda</CardTitle>
            <CardDescription>Nyalakan, urutkan, lalu buka bagian untuk mengaturnya. Pratinjau di samping mengikuti setiap perubahan.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <ol className="flex flex-col divide-y" aria-label="Urutan bagian beranda">
              {settings.order.map((id, index) => {
                const meta = SECTION_META[id];
                const locked = id === "catalog";
                const expanded = open === id;
                return (
                  <li key={id} data-home-section={id}>
                    <Collapsible open={expanded} onOpenChange={(next) => setOpen(next ? id : null)}>
                      <div className="flex items-center gap-2 px-4 py-3 sm:px-6">
                        <div className="flex flex-col">
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Naikkan ${meta.title}`} disabled={index === 0} onClick={() => move(id, -1)}>
                            <ArrowUp />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Turunkan ${meta.title}`} disabled={index === settings.order.length - 1} onClick={() => move(id, 1)}>
                            <ArrowDown />
                          </Button>
                        </div>
                        <CollapsibleTrigger data-section-toggle aria-label={`Atur ${meta.title}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-ring">
                          <span className="min-w-0 flex-1">
                            <span className={cn("block text-sm font-medium", !enabled(id) && "text-muted-foreground")}>{meta.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">{meta.hint}</span>
                          </span>
                          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
                        </CollapsibleTrigger>
                        {locked ? (
                          <Lock className="mx-2 size-4 text-muted-foreground" aria-label="Katalog selalu tampil" />
                        ) : (
                          <Switch aria-label={meta.title} checked={enabled(id)} onCheckedChange={(checked) => set(id, { enabled: Boolean(checked) } as never)} />
                        )}
                      </div>
                      <CollapsibleContent>
                        <div className="flex flex-col gap-4 border-t bg-muted/30 px-4 py-4 sm:px-6">
                          <SectionFields id={id} settings={settings} set={set} products={activeProducts} />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Warna aksen</CardTitle>
            <CardDescription>Tombol, tautan, dan pilihan di toko. Warna yang terlalu terang untuk tulisan putih ditolak supaya tombol tetap terbaca.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pilihan warna">
              {SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={accent.toUpperCase() === swatch}
                  aria-label={swatch}
                  onClick={() => setAccent(swatch)}
                  className="grid size-10 place-items-center rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:border-foreground aria-checked:ring-2 aria-checked:ring-foreground/15"
                >
                  <span className="size-6 rounded-md" style={{ background: swatch }} />
                </button>
              ))}
            </div>
            <label className="flex w-40 flex-col gap-1.5">
              <span className="text-sm font-medium">Kode warna</span>
              <Input value={accent} maxLength={7} spellCheck={false} className="font-mono" onChange={(event) => setAccent(event.target.value.trim())} />
            </label>
          </CardContent>
        </Card>
      </div>

      <aside className="hidden xl:block" aria-label="Pratinjau beranda">
        <div className="sticky top-20 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-medium"><Eye className="size-4 text-muted-foreground" aria-hidden="true" />Pratinjau</p>
            <span className="text-xs text-muted-foreground">{dirty ? "Belum disimpan" : "Sama dengan toko"}</span>
          </div>
          <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
            {previewSrc && <iframe title="Pratinjau beranda toko" src={previewSrc} className="h-[calc(100dvh-12rem)] w-full" />}
          </div>
        </div>
      </aside>

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur xl:col-span-2 xl:mx-0 xl:rounded-xl xl:border">
        <p className="text-sm text-muted-foreground" role="status">{dirty ? "Ada perubahan yang belum disimpan." : "Semua perubahan tersimpan."}</p>
        <div className="flex items-center gap-2">
          <a href="/" target="_blank" rel="noopener" className={buttonVariants({ variant: "ghost" })}>
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            Lihat toko
          </a>
          {dirty && <Button type="button" variant="outline" onClick={reset} disabled={saving}>Batalkan</Button>}
          <Button type="button" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "Menyimpan…" : "Simpan"}</Button>
        </div>
      </div>
    </div>
  );
}

function SectionFields({
  id,
  settings,
  set,
  products,
}: {
  id: HomeSectionId;
  settings: StoreThemeSettings;
  set: <K extends HomeSectionId>(id: K, patch: Partial<StoreThemeSettings["sections"][K]>) => void;
  products: ProductOption[];
}) {
  const s = settings.sections;
  if (id === "announcement") {
    return (
      <>
        <Field label="Teks" hint={`${s.announcement.text.length}/90`}>
          <Input value={s.announcement.text} maxLength={90} placeholder="Gratis ongkir se-Jawa sampai Minggu" onChange={(event) => set("announcement", { text: event.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Link (opsional)" hint="Halaman toko (/produk) atau https://">
            <Input value={s.announcement.href} maxLength={200} placeholder="/produk" spellCheck={false} onChange={(event) => set("announcement", { href: event.target.value.trim() })} />
          </Field>
          <Field label="Tampil sampai (opsional)" hint="Termasuk hari itu, WIB. Kosong = terus tampil.">
            <Input type="date" value={s.announcement.until} onChange={(event) => set("announcement", { until: event.target.value })} />
          </Field>
        </div>
      </>
    );
  }
  if (id === "hero") {
    const source = HERO_SOURCES.find((option) => option.value === s.hero.source)!;
    return (
      <>
        <Field label="Isi hero" hint={source.hint}>
          <div role="radiogroup" aria-label="Isi hero" className="inline-flex w-full rounded-lg bg-muted p-[3px] sm:w-auto">
            {HERO_SOURCES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={s.hero.source === option.value}
                onClick={() => set("hero", { source: option.value })}
                className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm"
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>
        {s.hero.source === "products" && <ProductPicker label="Produk hero" max={5} value={s.hero.productIds} products={products} onChange={(productIds) => set("hero", { productIds })} />}
        {s.hero.source === "banner" && <p className="text-xs text-muted-foreground">Unggah banner di bagian Banner beranda di atas. Selama belum ada, hero memakai produk otomatis.</p>}
        <ToggleRow label="Ringkasan produk" hint="Satu baris deskripsi di bawah nama produk pada slide." checked={s.hero.summary} onChange={(summary) => set("hero", { summary })} />
      </>
    );
  }
  if (id === "featured") {
    return (
      <>
        <Field label="Judul" hint={`${s.featured.title.length}/40`}>
          <Input value={s.featured.title} maxLength={40} onChange={(event) => set("featured", { title: event.target.value })} />
        </Field>
        <ProductPicker label="Produk" min={2} max={6} value={s.featured.productIds} products={products} onChange={(productIds) => set("featured", { productIds })} />
      </>
    );
  }
  if (id === "catalog") {
    return (
      <>
        <Field label="Judul" hint={`${s.catalog.title.length}/60`}>
          <Input aria-label="Judul katalog" value={s.catalog.title} maxLength={60} onChange={(event) => set("catalog", { title: event.target.value })} />
        </Field>
        <Field label="Deskripsi (opsional)" hint={`${s.catalog.description.length}/160`}>
          <Input value={s.catalog.description} maxLength={160} onChange={(event) => set("catalog", { description: event.target.value })} />
        </Field>
        <Field label="Urutan produk">
          <Select items={SORT_LABELS} value={s.catalog.sort} onValueChange={(value) => value && set("catalog", { sort: value as CatalogSort })}>
            <SelectTrigger aria-label="Urutan produk" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {(Object.keys(SORT_LABELS) as CatalogSort[]).map((sort) => (
                <SelectItem key={sort} value={sort}>{SORT_LABELS[sort]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <ToggleRow label="Filter kategori" hint="Tombol kategori di atas katalog, bila produk Anda punya lebih dari satu kategori." checked={s.catalog.categories} onChange={(categories) => set("catalog", { categories })} />
      </>
    );
  }
  if (id === "trust") return <p className="text-xs text-muted-foreground">Isinya otomatis dari pengaturan checkout (COD, QRIS/VA, kurir aktif), jadi selalu benar untuk toko Anda.</p>;
  return <p className="text-xs text-muted-foreground">Langkahnya ditulis dari metode bayar toko: toko COD meminta alamat, toko bayar-online tidak.</p>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 text-sm font-medium">
        {label}
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={(value) => onChange(Boolean(value))} />
    </div>
  );
}

/** Up to `max` active products in the seller's order: add from a list, reorder, remove. */
function ProductPicker({
  label,
  min = 1,
  max,
  value,
  products,
  onChange,
}: {
  label: string;
  min?: number;
  max: number;
  value: string[];
  products: ProductOption[];
  onChange: (ids: string[]) => void;
}) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const chosen = value.filter((id) => byId.has(id));
  const left = products.filter((product) => !chosen.includes(product.id));
  const swap = (from: number, to: number) => {
    const next = [...chosen];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-baseline justify-between text-sm font-medium">
        {label}
        <span className="text-xs font-normal text-muted-foreground">{chosen.length}/{max}{chosen.length < min ? ` · minimal ${min}` : ""}</span>
      </p>
      {chosen.length > 0 && (
        <ol className="flex flex-col divide-y rounded-lg border bg-background" aria-label={`${label} terpilih`}>
          {chosen.map((id, index) => {
            const product = byId.get(id)!;
            return (
              <li key={id} className="flex items-center gap-2 px-2 py-1.5">
                <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                {product.image ? <img src={product.image} alt="" className="size-8 shrink-0 rounded-md border object-cover" /> : <span className="size-8 shrink-0 rounded-md border bg-muted" />}
                <span className="min-w-0 flex-1 truncate text-sm">{product.title}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Naikkan ${product.title}`} disabled={index === 0} onClick={() => swap(index, index - 1)}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Turunkan ${product.title}`} disabled={index === chosen.length - 1} onClick={() => swap(index, index + 1)}><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="xs" onClick={() => onChange(chosen.filter((other) => other !== id))}>Hapus</Button>
              </li>
            );
          })}
        </ol>
      )}
      {chosen.length < max && left.length > 0 && (
        <Select items={Object.fromEntries(left.map((product) => [product.id, product.title]))} value={null} onValueChange={(next) => next && onChange([...chosen, String(next)])}>
          <SelectTrigger aria-label={`Tambah ${label.toLowerCase()}`} className="w-full">
            <SelectValue placeholder="+ Tambah produk" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {left.map((product) => (
              <SelectItem key={product.id} value={product.id}>
                <span className="truncate">{product.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {products.length === 0 && <p className="text-xs text-muted-foreground">Belum ada produk aktif.</p>}
    </div>
  );
}

