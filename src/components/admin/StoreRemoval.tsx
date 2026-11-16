import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "./useConfirm";

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" }).format(new Date(iso));

/**
 * PRIV-4 (T-26): the owner asks for the store to be removed, 30 days later,
 * and can cancel until then. The API enforces owner-only.
 */
export function StoreRemoval() {
  const [purgeAfter, setPurgeAfter] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    fetch("/api/admin/store-removal", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => setPurgeAfter(payload?.success ? payload.data.purge_after : null))
      .catch(() => setPurgeAfter(null));
  }, []);

  const send = async (method: "POST" | "DELETE") => {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/store-removal", { method, headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Permintaan gagal.");
      setPurgeAfter(payload.data.purge_after);
      toast.success(payload.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Permintaan gagal.");
    } finally {
      setBusy(false);
    }
  };

  const request = async () => {
    if (!(await confirm({
      title: "Hapus toko ini?",
      description: "Toko tetap berjalan selama 30 hari, lalu seluruh data, domain, gambar, dan pesanan dihapus permanen. Anda bisa membatalkan sampai tanggal itu.",
      confirmLabel: "Jadwalkan penghapusan",
    }))) return;
    await send("POST");
  };

  if (purgeAfter === undefined) return null;
  return (
    <section className="rounded-xl border border-rose-200 bg-white p-5 shadow-sm md:p-6" aria-labelledby="storeRemovalTitle">
      <h2 id="storeRemovalTitle" className="font-semibold text-slate-950">Hapus toko</h2>
      {purgeAfter ? (
        <>
          <p className="mt-1 text-sm text-rose-800">Toko dijadwalkan dihapus pada {formatDate(purgeAfter)}.</p>
          <Button variant="outline" className="mt-3" disabled={busy} onClick={() => void send("DELETE")}>
            {busy ? "Membatalkan…" : "Batalkan penghapusan"}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600">Penghapusan berlaku 30 hari setelah diminta dan bisa dibatalkan selama itu.</p>
          <Button variant="destructive" className="mt-3" disabled={busy} onClick={() => void request()}>
            {busy ? "Memproses…" : "Minta hapus toko"}
          </Button>
        </>
      )}
      {dialog}
    </section>
  );
}
