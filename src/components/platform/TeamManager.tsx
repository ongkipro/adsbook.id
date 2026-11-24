import * as React from "react";
import { toast } from "sonner";
import { KeyRound, MoreHorizontal, Power, ShieldCheck, UserCog, UserPlus } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { FilterSelect } from "../admin/filter-bar";
import { useConfirm } from "../admin/useConfirm";

export type TeamMember = {
  id: string;
  email: string;
  role: "platform_owner" | "platform_support";
  mfa: number;
  disabled_at: string | null;
  last_sign_in: string | null;
};

type Role = TeamMember["role"];
const ROLE_LABEL: Record<Role, string> = { platform_support: "Support", platform_owner: "Owner" };
// The seller admin's role picker (AccessManager edit dialog): FilterSelect, a
// DropdownMenu radio group. Base UI's Select cannot open inside a Radix modal
// Dialog — the dialog disables pointer events outside its content and the
// select's popup is portalled outside it — so the field never opened.
const ROLE_OPTIONS = [
  { value: "platform_support" as const, label: "Support — lihat, tangguhkan, cek tagihan" },
  { value: "platform_owner" as const, label: "Owner — semua, termasuk tim dan uang" },
];
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(iso)) : "—";

type Secret = { email: string; secret: string; uri: string; title: string };
type Panel = { kind: "add" } | { kind: "role"; member: TeamMember } | { kind: "reset"; member: TeamMember } | { kind: "secret"; secret: Secret };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const payload = (await response?.json().catch(() => ({}))) as
    | { success?: boolean; message?: string; error?: string; data?: { email: string; totp_secret: string; otpauth_uri: string } }
    | undefined;
  return payload ?? { success: false, error: "Koneksi terputus. Coba lagi." };
}

/**
 * UX-10 (T-52): the platform team, platform_owner only, in the seller admin's
 * access-manager idiom — table, a row menu, dialogs, useConfirm, toasts.
 * Add, change role, reset password + authenticator, disable / enable. A TOTP
 * secret is shown once in a dialog and never again.
 */
export function TeamManager({ members, selfId }: { members: TeamMember[]; selfId: string }) {
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const [pending, setPending] = React.useState(false);
  const [role, setRole] = React.useState<Role>("platform_support");
  const [changed, setChanged] = React.useState(false);
  const { confirm, dialog } = useConfirm();

  const close = () => {
    if (pending) return;
    setPanel(null);
    if (changed) window.location.reload();
  };
  const reloadSoon = () => window.setTimeout(() => window.location.reload(), 700);

  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setPending(true);
    const values = Object.fromEntries(new FormData(form));
    const payload = await post("/api/platform/team", { email: values.email, password: values.password, role });
    setPending(false);
    if (!payload.success || !payload.data) return void toast.error(payload.error ?? "Gagal menambah anggota.");
    toast.success(payload.message ?? "Anggota ditambahkan.");
    setChanged(true);
    setPanel({ kind: "secret", secret: { email: payload.data.email, secret: payload.data.totp_secret, uri: payload.data.otpauth_uri, title: "Anggota ditambahkan" } });
  };

  const saveRole = async () => {
    if (panel?.kind !== "role") return;
    if (role === panel.member.role) return void setPanel(null);
    setPending(true);
    const payload = await post(`/api/platform/team/${encodeURIComponent(panel.member.id)}`, { op: "role", role });
    setPending(false);
    if (!payload.success) return void toast.error(payload.error ?? "Gagal mengubah peran.");
    toast.success(payload.message ?? "Peran diubah.");
    setPanel(null);
    reloadSoon();
  };

  const reset = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (panel?.kind !== "reset") return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const member = panel.member;
    if (!(await confirm({ title: `Reset akses ${member.email}?`, description: "Password dan authenticator lamanya berhenti berlaku dan semua sesinya ditutup. Ia masuk lagi dengan password dan kode authenticator baru.", confirmLabel: "Reset akses" }))) return;
    setPending(true);
    const payload = await post(`/api/platform/team/${encodeURIComponent(member.id)}`, { op: "reset", password: new FormData(form).get("password") });
    setPending(false);
    if (!payload.success || !payload.data) return void toast.error(payload.error ?? "Gagal mereset akses.");
    toast.success(payload.message ?? "Akses direset.");
    setChanged(true);
    setPanel({ kind: "secret", secret: { email: payload.data.email, secret: payload.data.totp_secret, uri: payload.data.otpauth_uri, title: "Akses direset" } });
  };

  const toggle = async (member: TeamMember) => {
    const op = member.disabled_at ? "enable" : "disable";
    if (op === "disable" && !(await confirm({ title: `Nonaktifkan ${member.email}?`, description: "Sesinya langsung ditutup dan ia tidak bisa masuk lagi sampai diaktifkan kembali.", confirmLabel: "Nonaktifkan" }))) return;
    const payload = await post(`/api/platform/team/${encodeURIComponent(member.id)}`, { op });
    if (!payload.success) return void toast.error(payload.error ?? "Gagal.");
    toast.success(payload.message ?? "Tersimpan.");
    reloadSoon();
  };

  const roleField = (id: string) => (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-600">Peran</label>
      <FilterSelect id={id} icon={ShieldCheck} value={role} options={ROLE_OPTIONS} onValueChange={setRole} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => { setRole("platform_support"); setPanel({ kind: "add" }); }}>
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
            {members.map((member) => {
              const self = member.id === selfId;
              return (
                <TableRow key={member.id}>
                  <TableCell className="px-4 font-medium text-slate-900">
                    {member.email}
                    {self && <span className="ml-2 text-xs font-normal text-slate-500">(Anda)</span>}
                  </TableCell>
                  <TableCell className="px-4">{ROLE_LABEL[member.role]}</TableCell>
                  <TableCell className="px-4">{member.mfa ? "Aktif" : "Belum"}</TableCell>
                  <TableCell className="px-4">{member.disabled_at ? <Badge variant="outline">Nonaktif</Badge> : <Badge variant="secondary">Aktif</Badge>}</TableCell>
                  <TableCell className="px-4 text-slate-600">{when(member.last_sign_in)}</TableCell>
                  <TableCell className="px-4 text-right">
                    {self ? (
                      <span className="text-xs text-slate-400">Diatur owner lain</span>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label={`Aksi untuk ${member.email}`} />}>
                            <MoreHorizontal aria-hidden="true" />
                          </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => { setRole(member.role); setPanel({ kind: "role", member }); }}>
                            <UserCog aria-hidden="true" /> Ubah peran
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setPanel({ kind: "reset", member })}>
                            <KeyRound aria-hidden="true" /> Reset password & authenticator
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant={member.disabled_at ? "default" : "destructive"} onClick={() => void toggle(member)}>
                            <Power aria-hidden="true" /> {member.disabled_at ? "Aktifkan" : "Nonaktifkan"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs leading-5 text-slate-500">Support bisa melihat semua toko, tagihan, dan kesehatan, menangguhkan toko, dan mengecek pembayaran. Owner juga bisa memberi hari langganan, memulihkan owner toko, menghapus toko, dan mengelola tim. Selalu tersisa minimal satu owner aktif.</p>

      <Dialog open={panel !== null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent className="sm:max-w-md">
          {panel?.kind === "add" && (
            <form onSubmit={add} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Tambah anggota tim</DialogTitle>
                <DialogDescription>Akun baru wajib memakai kode authenticator untuk masuk.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="memberEmail" className="text-xs font-medium text-slate-600">Email</label>
                <Input id="memberEmail" name="email" type="email" required autoComplete="off" />
              </div>
              {roleField("memberRole")}
              <div className="grid gap-1.5">
                <label htmlFor="memberPassword" className="text-xs font-medium text-slate-600">Password awal (min. 12)</label>
                <Input id="memberPassword" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={pending}>Batal</Button>
                <Button type="submit" disabled={pending}>{pending ? "Menambah…" : "Tambah"}</Button>
              </DialogFooter>
            </form>
          )}
          {panel?.kind === "role" && (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Ubah peran</DialogTitle>
                <DialogDescription>{panel.member.email} · sekarang {ROLE_LABEL[panel.member.role]}.</DialogDescription>
              </DialogHeader>
              {roleField("memberRoleEdit")}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={pending}>Batal</Button>
                <Button type="button" onClick={() => void saveRole()} disabled={pending || role === panel.member.role}>{pending ? "Menyimpan…" : "Simpan peran"}</Button>
              </DialogFooter>
            </div>
          )}
          {panel?.kind === "reset" && (
            <form onSubmit={reset} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Reset password & authenticator</DialogTitle>
                <DialogDescription>Untuk {panel.member.email}. Berikan password baru dan kode authenticator baru lewat jalur aman.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="resetPassword" className="text-xs font-medium text-slate-600">Password awal baru (min. 12)</label>
                <Input id="resetPassword" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={pending}>Batal</Button>
                <Button type="submit" variant="destructive" disabled={pending}>{pending ? "Mereset…" : "Reset akses"}</Button>
              </DialogFooter>
            </form>
          )}
          {panel?.kind === "secret" && (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{panel.secret.title} — simpan kode authenticator</DialogTitle>
                <DialogDescription>Hanya tampil sekali. Berikan ke {panel.secret.email} lewat jalur aman; ia memasukkannya ke Google Authenticator, 1Password, atau Authy.</DialogDescription>
              </DialogHeader>
              <div id="enrolment" className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="status">
                <p className="text-xs text-amber-900">TOTP secret</p>
                <code id="enrolSecret" className="break-all font-mono text-sm">{panel.secret.secret}</code>
                <p className="mt-1 text-xs text-amber-900">otpauth URI</p>
                <code className="break-all font-mono text-xs">{panel.secret.uri}</code>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(panel.secret.secret).then(() => toast.success("Secret disalin."))}>Salin secret</Button>
                <Button type="button" onClick={close}>Selesai</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {dialog}
    </div>
  );
}
