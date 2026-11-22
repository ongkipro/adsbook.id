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

type Link = { email: string; link: string; expiresAt: string; purpose: "password_reset" | "enrollment" };
type Panel = { kind: "add" } | { kind: "role"; member: TeamMember } | { kind: "link"; member: TeamMember } | { kind: "issued"; link: Link };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const payload = (await response?.json().catch(() => ({}))) as
    | { success?: boolean; message?: string; error?: string; data?: { email: string; link: string; expires_at: string; purpose: Link["purpose"] } }
    | undefined;
  return payload ?? { success: false, error: "Koneksi terputus. Coba lagi." };
}

/** The owner's own fresh code: every credential action is stepped up (IAM-11). */
function StepUpField({ id }: { id: string }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-600">Kode autentikator Anda (owner)</label>
      <Input id={id} name="totp" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="font-mono tracking-widest" />
    </div>
  );
}

/**
 * UX-10 (T-52): the platform team, platform_owner only, in the seller admin's
 * access-manager idiom — table, a row menu, dialogs, useConfirm, toasts.
 * Add (with an enrollment link), change role, a password-reset link for a
 * support member, disable / enable. IAM-11 (T-53): no factor of another
 * operator is ever shown or set here; a single-use link is shown once, behind
 * the owner's own fresh TOTP code, to pass on through a verified channel.
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
    const payload = await post("/api/platform/team", { email: values.email, totp: values.totp, role });
    setPending(false);
    if (!payload.success || !payload.data) return void toast.error(payload.error ?? "Gagal menambah anggota.");
    toast.success(payload.message ?? "Anggota ditambahkan.");
    setChanged(true);
    setPanel({ kind: "issued", link: { email: payload.data.email, link: payload.data.link, expiresAt: payload.data.expires_at, purpose: payload.data.purpose } });
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

  const issueLink = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (panel?.kind !== "link") return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setPending(true);
    const payload = await post(`/api/platform/team/${encodeURIComponent(panel.member.id)}`, { op: "link", totp: new FormData(form).get("totp") });
    setPending(false);
    if (!payload.success || !payload.data) return void toast.error(payload.error ?? "Gagal membuat tautan.");
    toast.success(payload.message ?? "Tautan dibuat.");
    setChanged(true);
    setPanel({ kind: "issued", link: { email: payload.data.email, link: payload.data.link, expiresAt: payload.data.expires_at, purpose: payload.data.purpose } });
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
                  <TableCell className="px-4">
                    {member.disabled_at ? <Badge variant="outline">Nonaktif</Badge> : member.mfa ? <Badge variant="secondary">Aktif</Badge> : <Badge variant="outline">Menunggu aktivasi</Badge>}
                  </TableCell>
                  <TableCell className="px-4 text-slate-600">{when(member.last_sign_in)}</TableCell>
                  <TableCell className="px-4 text-right">
                    {self ? (
                      <span className="text-xs text-slate-400">Diatur owner lain</span>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="outline" size="icon" aria-label={`Aksi untuk ${member.email}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onSelect={() => { setRole(member.role); setPanel({ kind: "role", member }); }}>
                            <UserCog aria-hidden="true" /> Ubah peran
                          </DropdownMenuItem>
                          {!member.disabled_at && (!member.mfa || member.role === "platform_support") && (
                            <DropdownMenuItem onSelect={() => setPanel({ kind: "link", member })}>
                              <KeyRound aria-hidden="true" /> {member.mfa ? "Tautan reset password" : "Tautan aktivasi baru"}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant={member.disabled_at ? "default" : "destructive"} onSelect={() => void toggle(member)}>
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
      <p className="text-xs leading-5 text-slate-500">Support bisa melihat semua toko, tagihan, dan kesehatan, menangguhkan toko, dan mengecek pembayaran. Owner juga bisa memberi hari langganan, memulihkan owner toko, menghapus toko, dan mengelola tim. Selalu tersisa minimal satu owner aktif. Password diganti sendiri di menu Akun; owner hanya bisa membuat tautan reset sekali pakai untuk support (autentikatornya tetap). Owner yang lupa password atau siapa pun yang kehilangan autentikator: prosedur break-glass.</p>

      <Dialog open={panel !== null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent className="sm:max-w-md">
          {panel?.kind === "add" && (
            <form onSubmit={add} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Tambah anggota tim</DialogTitle>
                <DialogDescription>Ia mengatur password dan autentikatornya sendiri lewat tautan aktivasi sekali pakai (berlaku 24 jam).</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <label htmlFor="memberEmail" className="text-xs font-medium text-slate-600">Email</label>
                <Input id="memberEmail" name="email" type="email" required autoComplete="off" />
              </div>
              {roleField("memberRole")}
              <StepUpField id="memberStepUp" />
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
          {panel?.kind === "link" && (
            <form onSubmit={issueLink} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{panel.member.mfa ? "Tautan reset password" : "Tautan aktivasi baru"}</DialogTitle>
                <DialogDescription>
                  {panel.member.mfa
                    ? `Untuk ${panel.member.email}. Semua sesinya langsung ditutup dan tautan lamanya batal. Ia tetap memakai autentikator yang sama; tautan berlaku 30 menit.`
                    : `Untuk ${panel.member.email}. Tautan aktivasi lamanya batal; yang baru berlaku 24 jam.`}
                </DialogDescription>
              </DialogHeader>
              <StepUpField id="linkStepUp" />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={pending}>Batal</Button>
                <Button type="submit" disabled={pending}>{pending ? "Membuat…" : "Buat tautan"}</Button>
              </DialogFooter>
            </form>
          )}
          {panel?.kind === "issued" && (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{panel.link.purpose === "enrollment" ? "Tautan aktivasi" : "Tautan reset password"} — tampil sekali</DialogTitle>
                <DialogDescription>Kirim hanya ke {panel.link.email} lewat jalur yang sudah terverifikasi (bukan grup atau email bersama). Sekali pakai, berlaku sampai {when(panel.link.expiresAt)} WIB.</DialogDescription>
              </DialogHeader>
              <div id="accessLink" className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="status">
                <p className="text-xs text-amber-900">Tautan</p>
                <code id="accessLinkValue" className="break-all font-mono text-xs">{panel.link.link}</code>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(panel.link.link).then(() => toast.success("Tautan disalin."))}>Salin tautan</Button>
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
