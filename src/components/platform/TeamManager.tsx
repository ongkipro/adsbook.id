import * as React from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { useConfirm } from "../admin/useConfirm";

export type TeamMember = {
  id: string;
  email: string;
  role: "platform_owner" | "platform_support";
  mfa: number;
  disabled_at: string | null;
  last_sign_in: string | null;
};

const ROLE_OPTIONS = { platform_support: "Support", platform_owner: "Owner" } as const;
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(iso)) : "—";

/**
 * UX-10 (T-52): the platform team, platform_owner only. Same table, badge,
 * dialog and confirmation as the seller admin's AccessManager. The TOTP
 * secret of a new member is shown once in the dialog and never again.
 */
export function TeamManager({ members, selfId }: { members: TeamMember[]; selfId: string }) {
  const [adding, setAdding] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [role, setRole] = React.useState<keyof typeof ROLE_OPTIONS>("platform_support");
  const [enrolment, setEnrolment] = React.useState<{ email: string; secret: string; uri: string } | null>(null);
  const { confirm, dialog } = useConfirm();

  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setPending(true);
    try {
      const values = Object.fromEntries(new FormData(form));
      const response = await fetch("/api/platform/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, role }),
      });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string; data?: { email: string; totp_secret: string; otpauth_uri: string } };
      if (!payload.success || !payload.data) {
        toast.error(payload.error ?? "Gagal menambah anggota.");
        return;
      }
      toast.success(payload.message ?? "Anggota ditambahkan.");
      setEnrolment({ email: payload.data.email, secret: payload.data.totp_secret, uri: payload.data.otpauth_uri });
    } catch {
      toast.error("Koneksi terputus. Coba lagi.");
    } finally {
      setPending(false);
    }
  };

  const toggle = async (member: TeamMember) => {
    const op = member.disabled_at ? "enable" : "disable";
    if (op === "disable" && !(await confirm({ title: `Nonaktifkan ${member.email}?`, description: "Sesinya langsung ditutup dan ia tidak bisa masuk lagi sampai diaktifkan kembali.", confirmLabel: "Nonaktifkan" }))) return;
    const response = await fetch(`/api/platform/team/${encodeURIComponent(member.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string } | undefined;
    if (!payload?.success) {
      toast.error(payload?.error ?? "Gagal.");
      return;
    }
    toast.success(payload.message ?? "Tersimpan.");
    window.setTimeout(() => window.location.reload(), 700);
  };

  const closeAdd = () => {
    if (pending) return;
    setAdding(false);
    if (enrolment) window.location.reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => { setEnrolment(null); setAdding(true); }}>
          <UserPlus aria-hidden="true" /> Tambah anggota
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <Table id="teamTable">
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead className="px-4 text-xs text-slate-500">Email</TableHead>
              <TableHead className="px-4 text-xs text-slate-500">Peran</TableHead>
              <TableHead className="px-4 text-xs text-slate-500">MFA</TableHead>
              <TableHead className="px-4 text-xs text-slate-500">Status</TableHead>
              <TableHead className="px-4 text-xs text-slate-500">Masuk terakhir</TableHead>
              <TableHead className="px-4"><span className="sr-only">Aksi</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="px-4 font-medium text-slate-900">
                  {member.email}
                  {member.id === selfId && <span className="ml-2 text-xs font-normal text-slate-500">(Anda)</span>}
                </TableCell>
                <TableCell className="px-4">{ROLE_OPTIONS[member.role]}</TableCell>
                <TableCell className="px-4">{member.mfa ? "Aktif" : "Belum"}</TableCell>
                <TableCell className="px-4">
                  {member.disabled_at ? <Badge variant="outline">Nonaktif</Badge> : <Badge variant="secondary">Aktif</Badge>}
                </TableCell>
                <TableCell className="px-4 text-slate-600">{when(member.last_sign_in)}</TableCell>
                <TableCell className="px-4 text-right">
                  {member.id !== selfId && (
                    <Button type="button" variant={member.disabled_at ? "outline" : "ghost"} className={member.disabled_at ? "" : "text-rose-700"} onClick={() => void toggle(member)}>
                      {member.disabled_at ? "Aktifkan" : "Nonaktifkan"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs leading-5 text-slate-500">Support bisa melihat semua toko, tagihan, dan kesehatan, menangguhkan toko, dan mengecek pembayaran. Owner juga bisa memberi hari langganan, memulihkan owner toko, menghapus toko, dan mengelola tim.</p>

      <Dialog open={adding} onOpenChange={(next) => { if (!next) closeAdd(); }}>
        <DialogContent className="sm:max-w-md">
          {enrolment ? (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Simpan kode authenticator</DialogTitle>
                <DialogDescription>Hanya tampil sekali. Berikan ke {enrolment.email} lewat jalur aman; ia memasukkannya ke Google Authenticator, 1Password, atau Authy.</DialogDescription>
              </DialogHeader>
              <div id="enrolment" className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="status">
                <p className="text-xs text-amber-900">TOTP secret</p>
                <code id="enrolSecret" className="break-all font-mono text-sm">{enrolment.secret}</code>
                <p className="mt-1 text-xs text-amber-900">otpauth URI</p>
                <code className="break-all font-mono text-xs">{enrolment.uri}</code>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(enrolment.secret).then(() => toast.success("Secret disalin."))}>Salin secret</Button>
                <Button type="button" onClick={closeAdd}>Selesai</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={add} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Tambah anggota tim</DialogTitle>
                <DialogDescription>Akun baru wajib memakai kode authenticator untuk masuk.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="memberEmail" className="text-xs font-medium text-slate-600">Email</label>
                <Input id="memberEmail" name="email" type="email" required autoComplete="off" />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="memberRole" className="text-xs font-medium text-slate-600">Peran</label>
                <Select items={ROLE_OPTIONS} value={role} onValueChange={(value) => value && setRole(value as keyof typeof ROLE_OPTIONS)}>
                  <SelectTrigger id="memberRole" aria-label="Peran" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ROLE_OPTIONS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="memberPassword" className="text-xs font-medium text-slate-600">Password awal (min. 12)</label>
                <Input id="memberPassword" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeAdd} disabled={pending}>Batal</Button>
                <Button type="submit" disabled={pending}>{pending ? "Menambah…" : "Tambah"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {dialog}
    </div>
  );
}
