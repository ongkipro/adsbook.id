import { useCallback, useEffect, useRef, useState } from "react";
import { AdminRequestError, isSubscriptionError, SubscriptionLink } from "./subscription-error";
import { Copy, Globe } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "./useConfirm";
import { Skeleton } from "@/components/ui/skeleton";

type Domain = {
  host: string;
  kind: "subdomain" | "custom";
  group: string | null;
  status: string;
  sslStatus: string | null;
  isPrimary: boolean;
  errors: string[];
  cnameTarget: string;
};

type Mode = "root" | "www" | "subdomain";

const MODES: Array<{ value: Mode; title: string; detail: string }> = [
  { value: "root", title: "Pakai domain utama", detail: "tokosaya.com dan www.tokosaya.com" },
  { value: "www", title: "Hanya www", detail: "Untuk registrar yang tidak bisa mengarahkan domain utama" },
  { value: "subdomain", title: "Subdomain", detail: "Misalnya toko.tokosaya.com" },
];

/** UX-3 live states: "Menunggu DNS → Menerbitkan sertifikat → Aktif". */
function stateOf(domain: Domain): { label: string; variant: "default" | "secondary" | "outline" } {
  if (domain.kind === "subdomain" || domain.status === "active") return { label: "Aktif", variant: "default" };
  if (domain.errors.length) return { label: "Menunggu DNS", variant: "outline" };
  return { label: "Menerbitkan sertifikat", variant: "secondary" };
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", Accept: "application/json" }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new AdminRequestError(payload.error || "Permintaan gagal.", payload.code);
  return payload;
}

/**
 * /admin/settings/domains (T-25, API-5): the always-on platform subdomain and
 * the store's own domains. Every rule lives in the API; this only shows state
 * and asks before a removal or a primary change.
 */
export function DomainManager({ initial }: { initial?: { domains: Domain[]; enabled: boolean } } = {}) {
  // The page renders the first list on the server, so the card is there from
  // the first paint instead of a 160px skeleton swapped for a taller list.
  const [domains, setDomains] = useState<Domain[] | null>(initial?.domains ?? null);
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [loadError, setLoadError] = useState("");
  // Disabled on the server render and enabled on mount, so no input is typed
  // into before React attaches its onChange (a pre-hydration fill left `host`
  // empty and the submit button disabled).
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [mode, setMode] = useState<Mode>("root");
  const [addError, setAddError] = useState("");
  const [addNeedsSubscription, setAddNeedsSubscription] = useState(false);
  const hostInput = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    const payload = await call("/api/admin/domains");
    setDomains(payload.data.domains);
    setEnabled(Boolean(payload.data.custom_domains_enabled));
  }, []);

  useEffect(() => {
    setHydrated(true);
    if (initial) return;
    load().catch((error) => setLoadError(error instanceof Error ? error.message : "Gagal memuat domain."));
  }, [load, initial]);

  const run = async (key: string, task: () => Promise<{ message?: string } | void>) => {
    setBusy(key);
    try {
      const result = await task();
      await load();
      if (result && result.message) toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Permintaan gagal.");
    } finally {
      setBusy(null);
    }
  };

  const path = (domain: Domain) => `/api/admin/domains/${encodeURIComponent(domain.host)}`;

  // Sellers set DNS from a phone: one tap copies the exact record name and target.
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} disalin: ${text}`);
    } catch {
      toast.error("Tidak bisa menyalin otomatis. Salin manual dari teks di atas.");
    }
  };

  // T-43: root -> `www` only. The root hostname is removed; `www` stays as it is.
  const switchToWww = async (domain: Domain) => {
    if (!(await confirm({
      title: `Pakai hanya www.${domain.host}?`,
      description: `Domain utama ${domain.host} dilepas dan tidak lagi membuka toko; www.${domain.host} tetap aktif. Arahkan ${domain.host} ke www lewat forwarding di registrar.`,
      confirmLabel: "Pindah ke www",
    }))) return;
    await run(domain.host, () => call(`${path(domain)}?only=host`, { method: "DELETE" }));
  };
  const remove = async (domain: Domain) => {
    if (!(await confirm({
      title: `Hapus domain ${domain.host}?`,
      description: "Toko tidak lagi bisa dibuka lewat domain ini. Bila ini domain utama, subdomain adsbook.my.id kembali menjadi domain utama.",
      confirmLabel: "Hapus domain",
    }))) return;
    await run(domain.host, () => call(path(domain), { method: "DELETE" }));
  };

  const makePrimary = async (domain: Domain) => {
    if (!(await confirm({
      title: `Jadikan ${domain.host} domain utama?`,
      description: "Canonical, sitemap, feed katalog, dan sumber event iklan memakai domain ini. Alamat lain tetap bisa dibuka, tetapi tidak diindeks mesin pencari.",
      confirmLabel: "Jadikan utama",
      tone: "default",
    }))) return;
    await run(domain.host, () => call(`${path(domain)}/primary`, { method: "POST", body: "{}" }));
  };

  // One store, one own domain (Paduka, 2026-11-16): with a domain in place the form replaces it.
  const current = domains?.find((domain) => domain.kind === "custom")?.group ?? null;
  const subdomain = domains?.find((domain) => domain.kind === "subdomain")?.host ?? "subdomain adsbook.my.id";

  const add = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setAddError("");
    setAddNeedsSubscription(false);
    const typed = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    const sameDomain = current !== null && (typed === current || typed === `www.${current}`);
    const replace = current !== null && !sameDomain;
    if (replace && !(await confirm({
      title: `Ganti ${current} dengan ${typed}?`,
      description: `${current} dilepas dari toko ini dan tidak lagi membuka toko; ${typed} dipasang sebagai gantinya. Sampai DNS dan SSL ${typed} aktif, toko dibuka di ${subdomain}. Domain yang dilepas tidak bisa langsung dipasang lagi.`,
      confirmLabel: "Ganti domain",
    }))) return;
    setBusy("add");
    try {
      const payload = await call("/api/admin/domains", { method: "POST", body: JSON.stringify({ host, mode, ...(replace ? { replace: true } : {}) }) });
      setHost("");
      await load();
      toast.success(payload.message);
    } catch (error) {
      setAddNeedsSubscription(isSubscriptionError(error));
      setAddError(error instanceof Error ? error.message : "Domain gagal ditambahkan.");
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800" role="alert">{loadError}</div>;
  }
  if (!domains) {
    return (
      <Skeleton className="h-40 rounded-xl" role="status" aria-busy="true">
        <span className="sr-only">Memuat domain.</span>
      </Skeleton>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Domain toko">
        {domains.map((domain) => {
          const state = stateOf(domain);
          const pending = domain.kind === "custom" && domain.status !== "active";
          const record = domain.group && domain.host === domain.group ? "@" : domain.host.split(".")[0];
          return (
            <li key={domain.host} className="flex flex-col gap-3 p-5 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2 break-all font-mono text-sm font-semibold text-slate-950">
                  <Globe className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {domain.host}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {domain.isPrimary && <Badge>Domain utama</Badge>}
                  {domain.kind === "subdomain" && <Badge variant="secondary">Selalu aktif</Badge>}
                  <Badge variant={state.variant}>{state.label}</Badge>
                </div>
              </div>
              {pending && (
                <div className="space-y-1 text-xs text-slate-600">
                  <p className="flex flex-wrap items-center gap-1.5">
                    Record DNS: <code className="rounded bg-slate-100 px-1.5 py-0.5">{record} CNAME {domain.cnameTarget}</code>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void copy(record, "Nama record")} aria-label={`Salin nama record ${record}`}>
                      <Copy className="size-3.5" aria-hidden="true" /> Nama: {record}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void copy(domain.cnameTarget ?? "", "Target CNAME")} aria-label={`Salin target CNAME ${domain.cnameTarget}`}>
                      <Copy className="size-3.5" aria-hidden="true" /> Target: {domain.cnameTarget}
                    </Button>
                  </div>
                  {/* PR-28: never fixed IPs; the root needs flattening or ALIAS/ANAME. */}
                  {record === "@" ? (
                    <p>Di Cloudflare DNS, CNAME di domain utama otomatis di-flatten. Di DNS lain pakai record ALIAS atau ANAME bila ada; kalau tidak ada, pakai mode “Hanya www”. Jangan pakai A record atau alamat IP.</p>
                  ) : !domains.some((other) => other.group === domain.group && other.host === domain.group) ? (
                    <p>Arahkan domain utama ke www lewat forwarding HTTPS di registrar (atau redirect rule di Cloudflare DNS).</p>
                  ) : null}
                  <p className="text-slate-500">Status di sini dibaca dari Cloudflare; pengecekan DNS hanya petunjuk, tidak memastikan record sudah benar.</p>
                </div>
              )}
              {domain.kind === "custom" && domain.isPrimary && domain.status === "active" && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  Aktif sebagai domain utama — alamat www dan {subdomain} otomatis dialihkan (301) ke domain ini. Login admin tetap bisa di {subdomain}/hello.
                </p>
              )}
              {domain.errors.map((message) => (
                <p key={message} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{message}</p>
              ))}
              {(pending || (domain.status === "active" && !domain.isPrimary) || domain.kind === "custom") && (
                <div className="flex flex-wrap gap-2">
                  {pending && (
                    <Button variant="outline" disabled={!hydrated || busy !== null} onClick={() => void run(domain.host, () => call(`${path(domain)}/recheck`, { method: "POST", body: "{}" }))}>
                      {busy === domain.host ? "Memeriksa…" : "Cek lagi"}
                    </Button>
                  )}
                  {domain.status === "active" && !domain.isPrimary && (
                    <Button variant="outline" disabled={!hydrated || busy !== null} onClick={() => void makePrimary(domain)}>Jadikan domain utama</Button>
                  )}
                  {/* T-43: switch a root claim to `www` only — keeps the `www` hostname as it is. */}
                  {domain.kind === "custom" && domain.host === domain.group && domains.some((other) => other.group === domain.group && other.host === `www.${domain.group}`) && (
                    <Button
                      variant="outline"
                      disabled={!hydrated || busy !== null}
                      onClick={() => void switchToWww(domain)}
                    >
                      Pindah ke www saja
                    </Button>
                  )}
                  {domain.kind === "custom" && domain.host === domain.group && (
                    <Button
                      variant="outline"
                      disabled={!hydrated || busy !== null || !enabled}
                      onClick={() => {
                        hostInput.current?.focus();
                        hostInput.current?.scrollIntoView({ block: "center" });
                      }}
                    >
                      Ganti domain
                    </Button>
                  )}
                  {domain.kind === "custom" && (
                    <Button variant="outline" className="text-rose-700" disabled={!hydrated || busy !== null} onClick={() => void remove(domain)}>Hapus</Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {enabled ? (
        <form onSubmit={(event) => void add(event)} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6" aria-busy={busy === "add"} noValidate>
          <h2 className="font-semibold text-slate-950">{current ? "Ganti domain sendiri" : "Tambah domain sendiri"}</h2>
          {current && (
            <p className="mt-1 text-xs text-slate-600">
              1 akun toko berlaku untuk 1 domain sendiri. Domain baru menggantikan {current}; untuk memakai domain lain sekaligus, buka toko baru.
            </p>
          )}
          <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="domainHost">Domain</label>
          <Input
            ref={hostInput}
            id="domainHost"
            disabled={!hydrated}
            className="mt-2 font-mono"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={253}
            placeholder="tokosaya.com"
            aria-describedby="domainHostHint"
            aria-invalid={addError ? true : undefined}
          />
          <p id="domainHostHint" className="mt-1 text-xs text-slate-500">Tanpa https:// dan tanpa garis miring.</p>
          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-slate-700">Cara memakai</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((option) => (
                <label key={option.value} className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs">
                  <input type="radio" name="mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-0.5" />
                  <span><strong className="block text-slate-900">{option.title}</strong>{option.detail}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-5 flex flex-col-reverse gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className={`min-h-5 text-xs font-semibold ${addError ? "text-rose-700" : "text-slate-500"}`} role={addError ? "alert" : "status"}>{addError}{addError && addNeedsSubscription && <> <SubscriptionLink /></>}</p>
            <Button type="submit" disabled={!hydrated || busy !== null || !host.trim()}>{busy === "add" ? (current ? "Mengganti…" : "Menambahkan…") : current ? "Ganti domain" : "Tambah domain"}</Button>
          </div>
        </form>
      ) : (
        <p className="text-xs font-semibold text-slate-500">Domain sendiri belum tersedia di platform ini.</p>
      )}
      {dialog}
    </div>
  );
}
