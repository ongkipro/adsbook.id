import * as React from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/button";

/**
 * UX-8: "Cek status" on a pending subscription invoice — one AutoLaris Advice
 * read through the cron's own path (credits at most once); the answer is a
 * toast, and a credited invoice reloads the page.
 */
export function InvoiceCheckButton({ invoiceId }: { invoiceId: string }) {
  const [pending, setPending] = React.useState(false);
  const check = async () => {
    setPending(true);
    try {
      const response = await fetch(`/api/platform/invoices/${encodeURIComponent(invoiceId)}/check`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string; data?: { outcome?: string } };
      if (!payload.success) {
        toast.error(payload.error ?? "Gagal memeriksa.");
        return;
      }
      const settled = payload.data?.outcome === "credited" || payload.data?.outcome === "already-paid";
      (settled ? toast.success : toast.info)(payload.message ?? "Diperiksa.");
      if (settled) window.setTimeout(() => window.location.reload(), 900);
    } catch {
      toast.error("Koneksi terputus. Coba lagi.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Button type="button" variant="outline" disabled={pending} onClick={() => void check()}>
      <RefreshCw className={pending ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden="true" />
      {pending ? "Memeriksa…" : "Cek status"}
    </Button>
  );
}
