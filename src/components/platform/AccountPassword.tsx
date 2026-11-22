import * as React from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * IAM-11 self change (T-53): current password, a fresh code from the
 * authenticator the operator already uses (enrollment is kept), and the new
 * password twice. Success closes every session, this one too, so the page
 * goes to the sign-in.
 */
export function AccountPassword({ email }: { email: string }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  // Server-rendered disabled: before hydration (or if the script never runs) nothing can be typed or submitted.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const confirm = form.elements.namedItem("confirm") as HTMLInputElement;
    confirm.setCustomValidity(values.confirm && values.confirm !== values.password ? "Password baru tidak sama." : "");
    if (!form.reportValidity()) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/platform/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: values.current, totp: values.totp, password: values.password }),
    }).catch(() => null);
    const payload = ((await response?.json().catch(() => null)) ?? { success: false, error: "Koneksi terputus. Coba lagi." }) as { success?: boolean; error?: string; message?: string };
    if (!payload.success) {
      setPending(false);
      return setError(payload.error ?? "Gagal mengganti password.");
    }
    toast.success(payload.message ?? "Password diganti.");
    window.setTimeout(() => window.location.assign("/platform/login"), 900);
  };

  return (
    <form method="post" action="/api/platform/account/password" onSubmit={submit} className="max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-busy={pending}>
      <fieldset disabled={!ready} className="m-0 grid min-w-0 gap-4 border-0 p-0">
      <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      <div className="grid gap-1.5">
        <label htmlFor="currentPassword" className="text-xs font-medium text-slate-600">Password sekarang</label>
        <Input id="currentPassword" name="current" type="password" required autoComplete="current-password" />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="newPassword" className="text-xs font-medium text-slate-600">Password baru (12–128 karakter)</label>
        <Input id="newPassword" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="confirmPassword" className="text-xs font-medium text-slate-600">Ulangi password baru</label>
        <Input id="confirmPassword" name="confirm" type="password" required maxLength={128} autoComplete="new-password" onInput={(event) => event.currentTarget.setCustomValidity("")} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="accountTotp" className="text-xs font-medium text-slate-600">Kode autentikator (kode baru, belum dipakai)</label>
        <Input id="accountTotp" name="totp" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="font-mono tracking-widest" />
      </div>
      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" role="alert">{error}</p>}
      <p className="text-xs leading-5 text-slate-500">Autentikator Anda tetap sama. Setelah disimpan, semua sesi Anda ditutup — termasuk yang ini — dan Anda masuk lagi dengan password baru.</p>
      <div>
        <Button type="submit" disabled={pending}>{pending ? "Menyimpan…" : "Ganti password"}</Button>
      </div>
      </fieldset>
    </form>
  );
}
