import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { processImageUpload } from "../../lib/client-image";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Slide = { image: string; alt: string; badge: string; text: string };
type HomeDocument = { heroSlides: Slide[] } & Record<string, unknown>;
type ContentRecord = { version: number; draft: HomeDocument | null; published: HomeDocument | null };
type BannerOp = "insert-first" | "replace-first" | "remove-first";

/**
 * The row this screen last read, as one snapshot: every write sends its
 * version, so nothing is written against a row the screen has not seen
 * (the same rule as ContentWorkbench, R1a).
 */
type Snapshot = { version: number; draft: Slide[]; published: Slide[] };

const sameSlide = (left?: Slide, right?: Slide) =>
  Boolean(left && right && left.image === right.image && left.alt === right.alt && left.badge === right.badge && left.text === right.text);

export function HomeBannerEditor({ storeName }: { storeName: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState<number | null | undefined>(undefined);
  const [refusal, setRefusal] = useState("");
  const [slide, setSlide] = useState<Slide>({ image: "", alt: "", badge: storeName, text: storeName });
  const touched = useRef(false);
  const latestRead = useRef(0);
  const writesBlocked = loading || saving || uploading || snapshot === null;

  const load = async () => {
    const read = ++latestRead.current;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/content?key=home", { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Konten beranda gagal dimuat.");
      if (read !== latestRead.current) return;
      const record = (payload.data || null) as ContentRecord | null;
      // The draft a banner write changes starts from the published copy when there is no draft.
      const draft = (record?.draft ?? record?.published)?.heroSlides ?? [];
      const next = { version: record?.version ?? 0, draft, published: record?.published?.heroSlides ?? [] };
      setSnapshot(next);
      setConflict(undefined);
      // Prefill once from the draft banner; never over what the operator typed.
      if (!touched.current && draft[0]) setSlide(draft[0]);
    } catch (error) {
      if (read === latestRead.current) setSnapshot(null);
      toast.error(error instanceof Error ? error.message : "Konten beranda gagal dimuat.");
    } finally {
      if (read === latestRead.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const edit = (field: keyof Slide, value: string) => {
    touched.current = true;
    setSlide((current) => ({ ...current, [field]: value }));
  };

  const upload = async (event: { preventDefault: () => void; currentTarget: HTMLFormElement }) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const original = new FormData(formElement).get("file");
    if (!(original instanceof File) || original.size === 0) {
      toast.error("Pilih gambar dulu.");
      return;
    }
    setUploading(true);
    try {
      // The admin image pipeline (src/lib/image-rules.ts): max 2 MB in, WebP at most 480 px wide out.
      const form = new FormData();
      form.set("file", (await processImageUpload(original)).display);
      const response = await fetch("/api/admin/media", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gambar gagal diunggah.");
      edit("image", String(payload.data?.url || ""));
      formElement.reset();
      toast.success("Gambar banner tersimpan di media toko.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Gambar gagal diunggah.");
    } finally {
      setUploading(false);
    }
  };

  const write = async (target: "draft" | "published", op: BannerOp) => {
    const current = snapshot;
    if (!current || writesBlocked) return;
    if (target === "draft" && op !== "remove-first" && (!slide.image || !slide.alt.trim())) {
      setRefusal("Unggah gambar dan isi teks alternatif dulu.");
      return;
    }
    setSaving(true);
    setRefusal("");
    try {
      const response = await fetch("/api/admin/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "banner",
          key: "home",
          target,
          op,
          expectedVersion: current.version,
          ...(target === "draft" && op !== "remove-first" ? { slide } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.code === "CONTENT_VERSION_CONFLICT") {
        setConflict(typeof payload.currentVersion === "number" ? payload.currentVersion : null);
        return;
      }
      if (response.status === 422) {
        setRefusal(String(payload.error || "Perubahan banner ditolak."));
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || "Perubahan banner gagal.");
      toast.success(target === "published" ? "Banner terbit diperbarui." : "Banner draft disimpan.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Perubahan banner gagal.");
    } finally {
      setSaving(false);
    }
  };

  const draftBanner = snapshot?.draft[0];
  const publishedBanner = snapshot?.published[0];
  const publishOptions: Array<{ op: BannerOp; label: string }> = [];
  if (draftBanner && !publishedBanner) publishOptions.push({ op: "insert-first", label: "Terbitkan banner draft" });
  if (draftBanner && publishedBanner && !sameSlide(draftBanner, publishedBanner)) {
    publishOptions.push({ op: "replace-first", label: "Ganti banner terbit dengan banner draft" });
    publishOptions.push({ op: "insert-first", label: "Tambahkan banner draft di depan banner terbit" });
  }
  if (publishedBanner) publishOptions.push({ op: "remove-first", label: "Hapus banner terbit" });
  const previewHref = (op: BannerOp) => `/?preview=banner&op=${op}&v=${snapshot?.version ?? 0}`;

  const thumb = (banner: Slide | undefined, others: number, caption: string) => (
    <figure className="space-y-2">
      <figcaption className="text-xs font-semibold text-slate-700">{caption}</figcaption>
      {banner ? (
        <img src={banner.image} alt={banner.alt} width={160} height={160} className="aspect-square w-40 rounded-lg border border-slate-200 object-cover" />
      ) : (
        <p className="flex aspect-square w-40 items-center justify-center rounded-lg border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">
          Tidak ada banner: toko menampilkan 3 foto produk yang berganti tiap hari.
        </p>
      )}
      {others > 0 && <p className="text-xs text-slate-500">{others} slide lain tetap, dikelola di Konten &amp; media.</p>}
    </figure>
  );

  return (
    <div className="grid grid-cols-1 gap-6">
      {conflict !== undefined && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
          <p>
            {conflict === null ? "Konten beranda dihapus di tempat lain." : `Konten beranda sudah diubah di tempat lain (sekarang versi ${conflict}).`}{" "}
            Isian Anda di bawah belum tersimpan dan tetap ada.
          </p>
          <Button type="button" variant="outline" disabled={loading || saving} onClick={() => void load()}>
            Muat versi terbaru
          </Button>
        </div>
      )}
      {refusal && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {refusal}
        </p>
      )}

      <Card>
        <CardHeader className="border-b border-slate-100">
          <CardTitle as="h3" className="text-base font-semibold">Banner beranda</CardTitle>
          <p className="text-xs leading-5 text-slate-500">
            Banner adalah slide pertama di beranda. Simpan ke draft dulu, lihat pratinjau, lalu terbitkan.
            {snapshot && <> Versi {snapshot.version}.</>}
            {loading && <span role="status"> Memuat…</span>}
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 p-5 md:grid-cols-2">
          {thumb(draftBanner, Math.max(0, (snapshot?.draft.length ?? 0) - 1), "Banner di draft")}
          {thumb(publishedBanner, Math.max(0, (snapshot?.published.length ?? 0) - 1), "Banner terbit (dilihat pembeli)")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-slate-100">
          <CardTitle as="h3" className="text-base font-semibold">1. Siapkan banner di draft</CardTitle>
          <p className="text-xs leading-5 text-slate-500">JPG, PNG, atau WebP maksimal 2 MB, otomatis jadi WebP persegi lebar 480 px. Pembeli belum melihat apa pun di langkah ini.</p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 p-5">
          <form onSubmit={upload} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              name="file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Pilih gambar banner"
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold"
            />
            <Button type="submit" variant="outline" disabled={uploading}>
              {uploading ? "Mengunggah…" : "Unggah gambar"}
            </Button>
          </form>
          {slide.image && <p className="break-all font-mono text-xs text-slate-500">Gambar: {slide.image}</p>}
          <label className="grid grid-cols-1 gap-1.5 text-xs font-semibold text-slate-700">
            Teks alternatif (wajib)
            <Input value={slide.alt} maxLength={160} onChange={(event) => edit("alt", event.target.value)} placeholder="Contoh: Paket hemat pupuk organik" />
          </label>
          <label className="grid grid-cols-1 gap-1.5 text-xs font-semibold text-slate-700">
            Label kecil
            <Input value={slide.badge} maxLength={160} onChange={(event) => edit("badge", event.target.value)} />
          </label>
          <label className="grid grid-cols-1 gap-1.5 text-xs font-semibold text-slate-700">
            Teks banner
            <Input value={slide.text} maxLength={1200} onChange={(event) => edit("text", event.target.value)} />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="button" disabled={writesBlocked} onClick={() => void write("draft", draftBanner ? "replace-first" : "insert-first")}>
              {draftBanner ? "Ganti banner draft" : "Simpan sebagai banner draft"}
            </Button>
            {draftBanner && (snapshot?.draft.length ?? 0) < 10 && (
              <Button type="button" variant="outline" disabled={writesBlocked} onClick={() => void write("draft", "insert-first")}>
                Tambah di depan banner draft
              </Button>
            )}
            {draftBanner && (
              <Button type="button" variant="outline" disabled={writesBlocked} onClick={() => void write("draft", "remove-first")}>
                Hapus banner draft
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-slate-100">
          <CardTitle as="h3" className="text-base font-semibold">2. Pratinjau lalu terbitkan</CardTitle>
          <p className="text-xs leading-5 text-slate-500">Hanya banner yang berubah. Perubahan lain di Konten &amp; media tetap draft.</p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-5">
          {publishOptions.length === 0 && <p className="text-sm text-slate-600">Tidak ada yang perlu diterbitkan: banner draft dan banner terbit sudah sama.</p>}
          {publishOptions.map(({ op, label }) => (
            <div key={op} data-publish-op={op} className="flex flex-col gap-2 border-b border-slate-100 pb-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-slate-800">{label}</p>
              <div className="flex gap-2">
                <a
                  href={previewHref(op)}
                  target="_blank"
                  rel="noopener"
                  aria-disabled={writesBlocked}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Pratinjau
                </a>
                <Button type="button" disabled={writesBlocked} onClick={() => void write("published", op)}>
                  Terbitkan
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-500">
            Editor lanjutan (semua teks dan slide lain): <a href="/admin/content" className="font-semibold text-blue-700 underline underline-offset-2">Konten &amp; media</a>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
