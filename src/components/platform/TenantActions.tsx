import * as React from "react";
import { toast } from "sonner";
import { CalendarPlus, KeyRound, PauseCircle, PlayCircle, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { useConfirm } from "../admin/useConfirm";

type Action = "grant-subscription" | "suspend" | "resume" | "recover" | "purge-request";
type AnyAction = Action | "plan";

/**
 * UX-4 tenant actions (T-52) in the seller admin's idiom: one card of buttons,
 * each opening a shadcn Dialog with its own fields; destructive ones confirm
 * through useConfirm, and the result is a toast. The server decides what is
 * allowed (ACTION_ROLES); `allowed` only hides what the role can never do.
 */
export function TenantActions({
  tenantId,
  slug,
  status,
  allowed,
  purgeScheduled,
}: {
  tenantId: string;
  slug: string;
  status: string;
  allowed: AnyAction[];
  purgeScheduled: boolean;
}) {
  const [open, setOpen] = React.useState<Action | null>(null);
  const [pending, setPending] = React.useState(false);
  const [recoveryToken, setRecoveryToken] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const can = (action: Action) => (allowed as string[]).includes(action);

  const run = async (action: Action, body: Record<string, unknown>) => {
    setPending(true);
    try {
      const response = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string; data?: { recovery_token?: string } };
      if (!payload.success) {
        toast.error(payload.error ?? "Aksi gagal.");
        return;
      }
      toast.success(payload.message ?? "Tersimpan.");
      if (payload.data?.recovery_token) {
        setRecoveryToken(payload.data.recovery_token);
        return;
      }
      setOpen(null);
      window.setTimeout(() => window.location.reload(), 700);
    } catch {
      toast.error("Koneksi terputus. Coba lagi.");
    } finally {
      setPending(false);
    }
  };

  const submit = (action: Action) => async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    if (action === "suspend" && !(await confirm({ title: `Tangguhkan ${slug}?`, description: "Toko, login admin, dan checkout langsung menjawab 403 sampai diaktifkan kembali.", confirmLabel: "Tangguhkan" }))) return;
    if (action === "purge-request" && !(await confirm({ title: `Jadwalkan penghapusan ${slug}?`, description: "Semua data toko dihapus permanen 30 hari lagi. Selama 30 hari itu penghapusan masih bisa dibatalkan lewat tim teknis.", confirmLabel: "Jadwalkan penghapusan" }))) return;
    await run(action, values);
  };

  const buttons: { action: Action; label: string; icon: typeof CalendarPlus; show: boolean; variant: "default" | "outline" | "destructive" }[] = [
    { action: "grant-subscription", label: "Beri langganan", icon: CalendarPlus, show: can("grant-subscription") && status === "active", variant: "default" },
    { action: "suspend", label: "Tangguhkan", icon: PauseCircle, show: can("suspend") && status === "active", variant: "outline" },
    { action: "resume", label: "Aktifkan kembali", icon: PlayCircle, show: can("resume") && status === "suspended", variant: "default" },
    { action: "recover", label: "Kode pemulihan owner", icon: KeyRound, show: can("recover") && status === "active", variant: "outline" },
    { action: "purge-request", label: "Jadwalkan penghapusan", icon: Trash2, show: can("purge-request") && !purgeScheduled && status !== "purged", variant: "destructive" },
  ];
  const visible = buttons.filter((button) => button.show);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle as="h2" className="font-semibold">Aksi</CardTitle>
        <CardDescription>Setiap aksi tercatat di riwayat dengan nama Anda.</CardDescription>
      </CardHeader>
      <CardContent>
        {visible.length ? (
          <div className="flex flex-wrap gap-2">
            {visible.map((button) => (
              <Button key={button.action} type="button" variant={button.variant} onClick={() => { setRecoveryToken(null); setOpen(button.action); }}>
                <button.icon aria-hidden="true" />
                {button.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Tidak ada aksi untuk status toko ini atau peran Anda.</p>
        )}
      </CardContent>

      <Dialog open={open !== null} onOpenChange={(next) => { if (!next && !pending) setOpen(null); }}>
        <DialogContent className="sm:max-w-md">
          {open === "grant-subscription" && (
            <form onSubmit={submit("grant-subscription")} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Beri hari langganan</DialogTitle>
                <DialogDescription>Menambah hari dari tanggal berakhir yang sedang berjalan. Hanya owner platform; tercatat dengan alasannya.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="grantDays" className="text-xs font-medium text-slate-600">Jumlah hari</label>
                <Input id="grantDays" name="days" type="number" inputMode="numeric" required min={1} max={730} defaultValue={30} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="grantReason" className="text-xs font-medium text-slate-600">Alasan</label>
                <Input id="grantReason" name="reason" required minLength={5} maxLength={300} placeholder="Contoh: pilot Saraku" />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(null)} disabled={pending}>Batal</Button>
                <Button type="submit" disabled={pending}>{pending ? "Menyimpan…" : "Beri langganan"}</Button>
              </DialogFooter>
            </form>
          )}
          {(open === "suspend" || open === "resume") && (
            <form onSubmit={submit(open)} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{open === "suspend" ? `Tangguhkan ${slug}` : `Aktifkan kembali ${slug}`}</DialogTitle>
                <DialogDescription>{open === "suspend" ? "Untuk penyalahgunaan atau permintaan resmi. Data toko tetap utuh." : "Toko, login, dan checkout kembali berjalan."}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="actionReason" className="text-xs font-medium text-slate-600">Alasan</label>
                <Input id="actionReason" name="reason" required minLength={3} maxLength={500} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(null)} disabled={pending}>Batal</Button>
                <Button type="submit" variant={open === "suspend" ? "destructive" : "default"} disabled={pending}>{open === "suspend" ? "Tangguhkan" : "Aktifkan kembali"}</Button>
              </DialogFooter>
            </form>
          )}
          {open === "recover" && (
            <form onSubmit={submit("recover")} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Kode pemulihan owner</DialogTitle>
                <DialogDescription>Hanya setelah owner diverifikasi di luar sistem. Kode berlaku 24 jam, sekali pakai, dan dibuka owner di /pemulihan pada subdomain tokonya.</DialogDescription>
              </DialogHeader>
              {recoveryToken ? (
                <div className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="status">
                  <p className="font-medium">Salin sekarang — hanya tampil sekali.</p>
                  <code className="break-all font-mono text-xs">{recoveryToken}</code>
                  <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(recoveryToken).then(() => toast.success("Kode disalin."))}>Salin kode</Button>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <label htmlFor="recoverEvidence" className="text-xs font-medium text-slate-600">Ringkasan verifikasi (tanpa salinan dokumen)</label>
                  <Textarea id="recoverEvidence" name="evidence" required minLength={10} maxLength={500} rows={3} />
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(null)} disabled={pending}>{recoveryToken ? "Selesai" : "Batal"}</Button>
                {!recoveryToken && <Button type="submit" disabled={pending}>{pending ? "Membuat…" : "Buat kode"}</Button>}
              </DialogFooter>
            </form>
          )}
          {open === "purge-request" && (
            <form onSubmit={submit("purge-request")} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Jadwalkan penghapusan permanen</DialogTitle>
                <DialogDescription>Ketik <strong className="font-mono text-slate-900">{slug}</strong> untuk mengonfirmasi. Data dihapus 30 hari lagi.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="purgeSlug" className="text-xs font-medium text-slate-600">Alamat toko</label>
                <Input id="purgeSlug" name="slug" required autoComplete="off" pattern={slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(null)} disabled={pending}>Batal</Button>
                <Button type="submit" variant="destructive" disabled={pending}>Jadwalkan penghapusan</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {dialog}
    </Card>
  );
}
