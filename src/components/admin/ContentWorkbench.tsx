import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { processImageUpload } from "../../lib/client-image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

type Target = { key: string; label: string };
type ContentRecord = {
  content_key: string;
  version: number;
  generated_by: string;
  updated_at: string;
  published_at: string | null;
  draft: unknown;
  published: unknown;
};

type IndexData = {
  instructionsConfigured: boolean;
  canManageInstructions: boolean;
  targets: Target[];
};

/**
 * The target the editor holds: its key and the record (with the version) read
 * for that key, set together only by a read that succeeded. Every write takes
 * its key and `expectedVersion` from here, never from the picker, so a switch
 * that is still loading or that failed cannot send one target's document or
 * version to another.
 */
type LoadedTarget = { key: string; record: ContentRecord | null };

export function ContentWorkbench() {
  const [index, setIndex] = useState<IndexData | null>(null);
  const [loaded, setLoaded] = useState<LoadedTarget | null>(null);
  // The key being read for a switch; writes stay off until it lands or fails.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const latestRead = useRef(0);
  const [editor, setEditor] = useState("{}");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  // Set when the server refuses a write because the row moved on (409): the
  // editor keeps what the operator typed until they choose to load the newer one.
  const [conflict, setConflict] = useState<{ currentVersion: number | null } | null>(null);
  const record = loaded?.record ?? null;
  const writesBlocked = saving || loaded === null || pendingKey !== null;

  /** Reads `key` and, if it is still the latest read, makes it the loaded target. Throws on failure. */
  const loadTarget = async (key: string) => {
    const read = ++latestRead.current;
    const response = await fetch(`/api/admin/content?key=${encodeURIComponent(key)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || "Konten gagal dimuat.");
    }
    if (read !== latestRead.current) return; // a newer read owns the editor now
    const next = (payload.data || null) as ContentRecord | null;
    setLoaded({ key, record: next });
    setEditor(pretty(next?.draft ?? next?.published ?? {}));
    setConflict(null);
  };

  const loadLatest = async () => {
    if (!loaded) return;
    const key = loaded.key;
    setPendingKey(key);
    try {
      await loadTarget(key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Konten gagal dimuat.");
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/content", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Workbench konten gagal dimuat.");
        }
        setIndex(payload.data as IndexData);
        await loadTarget("home");
      })
      .catch((error) => {
        if (!(error instanceof Error && error.name === "AbortError")) {
          toast.error(error instanceof Error ? error.message : "Workbench konten gagal dimuat.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  // A failed switch keeps the loaded target and the operator's unsaved text;
  // the picker falls back to the loaded key once nothing is pending.
  const selectTarget = async (key: string) => {
    if (key === loaded?.key && pendingKey === null) return;
    setPendingKey(key);
    try {
      await loadTarget(key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Konten gagal dimuat.");
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
  };

  const mutate = async (action: "save-draft" | "generate" | "publish") => {
    const target = loaded;
    if (!target || pendingKey !== null) return;
    setSaving(true);
    try {
      let content: unknown;
      if (action === "save-draft") {
        try {
          content = JSON.parse(editor);
        } catch {
          throw new Error("Draft harus berupa JSON yang valid.");
        }
      }
      const response = await fetch("/api/admin/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The version this editor loaded; 0 when the row does not exist yet.
        body: JSON.stringify({ action, key: target.key, content, expectedVersion: target.record?.version ?? 0 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.code === "CONTENT_VERSION_CONFLICT") {
        setConflict({ currentVersion: typeof payload.currentVersion === "number" ? payload.currentVersion : null });
        return;
      }
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Aksi konten gagal.");
      }
      await loadTarget(target.key);
      toast.success(
        action === "publish"
          ? "Konten diterbitkan."
          : action === "generate"
            ? "Draft Workers AI berhasil dibuat."
            : "Draft disimpan.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aksi konten gagal.");
    } finally {
      setSaving(false);
    }
  };

  const saveInstructions = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-instructions", instructions }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Instruksi AI gagal disimpan.");
      }
      setIndex((current) =>
        current ? { ...current, instructionsConfigured: true } : current,
      );
      setInstructions("");
      toast.success("Instruksi tenant tersimpan tanpa ditampilkan kembali.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Instruksi AI gagal disimpan.");
    } finally {
      setSaving(false);
    }
  };

  const uploadMedia = async (event: {
    preventDefault: () => void;
    currentTarget: HTMLFormElement;
  }) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setUploading(true);
    try {
      // Hero and content images: the same pipeline as product photos
      // (src/lib/image-rules.ts): max 2 MB in, a WebP at most 480 px wide out.
      const original = form.get("file");
      if (!(original instanceof File)) throw new Error("File gambar wajib dipilih.");
      form.set("file", (await processImageUpload(original)).display);
      const response = await fetch("/api/admin/media", {
        method: "POST",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Media gagal diunggah.");
      }
      setMediaUrl(String(payload.data?.url || ""));
      event.currentTarget.reset();
      toast.success("Media tenant tersimpan di R2.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Media gagal diunggah.");
    } finally {
      setUploading(false);
    }
  };

  if (loading && !index) {
    return <div className="h-96 rounded-xl bg-slate-100" aria-label="Memuat workbench konten" />;
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader className="border-b border-slate-100">
          <CardTitle as="h3" className="text-base font-semibold">Draft Storefront</CardTitle>
          <p className="text-xs leading-5 text-slate-500">
            D1 adalah source of truth. Generate membuat draft; publish adalah aksi terpisah.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <label className="grid-cols-1 grid gap-2 text-xs font-semibold text-slate-700">
            Target konten
            <Select
              items={Object.fromEntries((index?.targets || []).map((target) => [target.key, target.label]))}
              // Shows the key being read while a switch is pending, else the loaded one.
              value={pendingKey ?? loaded?.key ?? "home"}
              onValueChange={(value) => value && void selectTarget(String(value))}
              disabled={loading || saving}
            >
              <SelectTrigger aria-label="Target konten" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(index?.targets || []).map((target) => (
                  <SelectItem key={target.key} value={target.key}>
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex flex-wrap gap-2 text-xs font-semibold text-slate-500">
            {pendingKey !== null ? (
              <span role="status">Memuat target…</span>
            ) : (
              <>
                <span>Versi {record?.version || 0}</span>
                <span>·</span>
                <span>{record?.generated_by || "belum ada draft"}</span>
                {record?.published_at && <span>· Published {record.published_at}</span>}
              </>
            )}
          </div>
          {conflict && (
            <div role="alert" className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <p>
                {conflict.currentVersion === null
                  ? "Konten ini sudah dihapus atau belum pernah disimpan di tempat lain."
                  : `Konten ini sudah diubah di tempat lain (sekarang versi ${conflict.currentVersion}).`}{" "}
                Isi editor Anda belum tersimpan dan tetap ada di bawah. Salin dulu bila perlu, lalu muat versi terbaru.
              </p>
              <Button type="button" variant="outline" disabled={writesBlocked} onClick={() => void loadLatest()}>
                Muat versi terbaru
              </Button>
            </div>
          )}
          <label className="grid-cols-1 grid gap-2 text-xs font-semibold text-slate-700">
            Draft JSON
            <Textarea
              data-code-editor
              value={editor}
              onChange={(event) => setEditor(event.target.value)}
              spellCheck={false}
              className="min-h-[30rem] resize-y bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100"
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button type="button" variant="outline" disabled={writesBlocked} onClick={() => void mutate("generate")}>
              Generate Workers AI
            </Button>
            <Button type="button" variant="outline" disabled={writesBlocked} onClick={() => void mutate("save-draft")}>
              Simpan Draft
            </Button>
            <Button type="button" disabled={writesBlocked || !record?.draft} onClick={() => void mutate("publish")}>
              Publish Draft
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle as="h3" className="text-sm font-semibold">Batas Operasional</CardTitle>
          </CardHeader>
          <CardContent className="text-xs leading-6 text-slate-600">
            AI hanya mengubah copy dan media reference. Harga, stok, SKU, variant ID, domain,
            provider, dan tracking tetap berasal dari D1/config operator.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h3" className="text-sm font-semibold">Media Tenant</CardTitle>
            <p className="text-xs leading-5 text-slate-500">
              Upload gambar ke R2 tenant, lalu gunakan URL hasilnya pada field image di draft JSON. JPG, PNG, atau WebP maksimal 2 MB; otomatis jadi WebP lebar maksimal 480 px.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <form onSubmit={uploadMedia} className="space-y-3">
              <input
                name="file"
                type="file"
                aria-label="Pilih gambar untuk diunggah"
                accept="image/jpeg,image/png,image/webp"
                required
                className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold"
              />
              <Button type="submit" variant="outline" disabled={uploading} className="w-full">
                {uploading ? "Mengunggah..." : "Upload ke R2"}
              </Button>
            </form>
            {mediaUrl && (
              <div className="space-y-2">
                <Input readOnly value={mediaUrl} aria-label="URL media" className="font-mono" />
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={() => void navigator.clipboard.writeText(mediaUrl)}
                >
                  Salin URL Media
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        {index?.canManageInstructions && (
          <Card>
            <CardHeader>
              <CardTitle as="h3" className="text-sm font-semibold">Instruksi Tenant</CardTitle>
              <p className="text-xs leading-5 text-slate-500">
                Guardrail dasar berasal dari repository. Isian ini hanya menambah aturan tenant dan tidak pernah ditampilkan kembali.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs font-semibold text-slate-600">
                Status: {index.instructionsConfigured ? "sudah dikonfigurasi" : "menggunakan guardrail repository"}
              </p>
              <Textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                minLength={20}
                maxLength={8000}
                rows={8}
                placeholder="Tambahkan tone, istilah, dan batas klaim khusus tenant..."
                aria-label="Instruksi konten tambahan"
                className="resize-y"
              />
              <Button
                type="button"
                className="w-full"
                disabled={saving || instructions.trim().length < 20}
                onClick={() => void saveInstructions()}
              >
                Simpan Instruksi Tenant
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
