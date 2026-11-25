import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type State = "preview" | "subscribed" | "grace" | "expired";
type Cycle = { code: "1m" | "3m" | "6m" | "12m"; days: number; amount: number; label: string };
type Channel = { code: string; name: string; fee: number; feeType: string };
type Invoice = {
  id: string;
  number: string;
  cycle: Cycle["code"];
  days: number;
  amount: number;
  adminFee: number;
  total: number;
  channel: string;
  qr: string | null;
  virtualAccount: string | null;
  paymentUrl: string | null;
  status: "pending" | "paid" | "expired" | "cancelled";
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
};
type Billing = {
  state: State;
  subscriptionEndsAt: string | null;
  graceEndsAt: string | null;
  configured: boolean;
  cycles: Cycle[];
  invoices: Invoice[];
  channels?: Channel[];
  channelError?: string | null;
  /** PR-26: the display-only demo store never subscribes. */
  demo?: boolean;
};

const idr = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(iso)) + " WIB" : "";

/** Labels for channel codes the provider sends without a name. */
const CHANNEL_NAMES: Record<string, string> = {
  QRIS: "QRIS (semua e-wallet & m-banking)",
  VABCA: "Virtual Account BCA",
  VAMANDIRI: "Virtual Account Mandiri",
  VABNI: "Virtual Account BNI",
  VABRI: "Virtual Account BRI",
  VAPERMATA: "Virtual Account Permata",
};
const channelName = (channel: { code: string; name?: string }) => CHANNEL_NAMES[channel.code] || channel.name || channel.code;

const CYCLE_NOTES: Record<Cycle["code"], string> = {
  "1m": "Fleksibel, perpanjang tiap bulan",
  "3m": "Hemat Rp48.000",
  "6m": "Hemat Rp135.000",
  "12m": "Bayar 10 bulan, gratis 2 bulan",
};

const STATUS_LABELS: Record<Invoice["status"], string> = { pending: "Menunggu pembayaran", paid: "Lunas", expired: "Kedaluwarsa", cancelled: "Diganti" };

function stateSummary(billing: Billing): { label: string; detail: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (billing.state) {
    case "subscribed":
      return { label: "Aktif", detail: `Aktif sampai ${when(billing.subscriptionEndsAt)}.`, variant: "default" };
    case "grace":
      return { label: "Masa tenggang 48 jam", detail: `Jatuh tempo ${when(billing.subscriptionEndsAt)}. Toko tetap jalan sampai ${when(billing.graceEndsAt)}.`, variant: "destructive" };
    case "expired":
      return { label: "Berakhir", detail: `Berakhir ${when(billing.subscriptionEndsAt)}. Pesanan, iklan, dan AI dijeda; data toko tetap aman.`, variant: "destructive" };
    default:
      return { label: "Mode Preview", detail: "Siapkan toko sepuasnya. Pesanan pembeli, sinyal iklan, AI, dan domain sendiri aktif setelah langganan dibayar.", variant: "secondary" };
  }
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", Accept: "application/json" }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(payload.error || "Permintaan gagal.");
  return payload;
}

function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  if (!until) return "";
  const left = Math.max(0, Date.parse(until) - now);
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function QrImage({ payload }: { payload: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // Loaded with the first QRIS invoice, not with the page: most visits to Langganan never draw one.
    let live = true;
    void import("qrcode").then(({ default: QRCode }) => {
      if (live && canvas.current) void QRCode.toCanvas(canvas.current, payload, { width: 232, margin: 1 });
    });
    return () => { live = false; };
  }, [payload]);
  return <canvas ref={canvas} aria-label="Kode QRIS untuk pembayaran langganan" role="img" className="mx-auto rounded-lg border border-slate-200" />;
}

/**
 * /admin/billing (T-50, UX-6): the store's subscription state, the four
 * Option A cycles, the platform's live QRIS/VA channels, the open
 * instruction, and the invoice history. Every rule lives in the API.
 */
export function BillingManager() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loadError, setLoadError] = useState("");
  const [cycle, setCycle] = useState<Cycle["code"]>(() => {
    if (typeof window === "undefined") return "12m";
    const requested = new URLSearchParams(window.location.search).get("cycle");
    return requested === "1m" || requested === "3m" || requested === "6m" || requested === "12m" ? requested : "12m";
  });
  const [channel, setChannel] = useState("QRIS");
  const [busy, setBusy] = useState<"create" | "check" | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/admin/billing");
      setBilling(payload.data);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Gagal memuat langganan.");
    }
  }, []);
  useEffect(() => void load(), [load]);

  const open = billing?.invoices.find((invoice) => invoice.status === "pending" && Date.parse(invoice.expiresAt) > Date.now()) ?? null;
  const countdown = useCountdown(open?.expiresAt ?? null);

  const create = async () => {
    setBusy("create");
    try {
      const payload = await call("/api/admin/billing", { method: "POST", body: JSON.stringify({ cycle, channel }) });
      setBilling((current) => ({ ...current, ...payload.data, channels: current?.channels, channelError: current?.channelError }));
      toast.success(payload.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Tagihan belum bisa dibuat.");
    } finally {
      setBusy(null);
    }
  };

  const check = async (invoice: Invoice) => {
    setBusy("check");
    try {
      const payload = await call(`/api/admin/billing/${encodeURIComponent(invoice.id)}/check`, { method: "POST" });
      setBilling((current) => ({ ...current, ...payload.data, channels: current?.channels, channelError: current?.channelError }));
      if (payload.data.outcome === "credited" || payload.data.outcome === "already-paid") toast.success(payload.message);
      else toast.info(payload.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Status belum bisa dicek.");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Nomor VA disalin: ${text}`);
    } catch {
      toast.error("Tidak bisa menyalin otomatis. Salin manual dari teks di atas.");
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
        {loadError} <Button variant="outline" onClick={() => void load()}>Muat ulang</Button>
      </div>
    );
  }
  if (!billing) {
    return <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white" aria-busy="true" aria-label="Memuat langganan" />;
  }

  if (billing.demo) {
    return (
      <section id="demoBilling" aria-labelledby="billingStateTitle" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="billingStateTitle" className="text-base font-semibold text-slate-950">Status langganan</h2>
          <Badge variant="secondary">Toko contoh</Badge>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">Ini toko contoh adsbook.id untuk melihat-lihat. Tidak perlu berlangganan, tidak ada tagihan, dan tidak bisa dibayar.</p>
      </section>
    );
  }

  const summary = stateSummary(billing);
  const channels = billing.channels ?? [];
  const chosenCycle = billing.cycles.find((entry) => entry.code === cycle);
  const history = billing.invoices.filter((invoice) => invoice !== open);

  return (
    <div className="space-y-6">
      <section aria-labelledby="billingStateTitle" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="billingStateTitle" className="text-base font-semibold text-slate-950">Status langganan</h2>
          <Badge variant={summary.variant}>{summary.label}</Badge>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">{summary.detail}</p>
        <p className="mt-1 text-xs text-slate-500">1 langganan = 1 toko dan 1 domain sendiri. Tanpa potongan per transaksi.</p>
      </section>

      {open && (
        <section aria-labelledby="openInvoiceTitle" className="rounded-xl border border-blue-200 bg-white p-5 shadow-sm md:p-6">
          <h2 id="openInvoiceTitle" className="text-base font-semibold text-slate-950">Selesaikan pembayaran</h2>
          <p className="mt-1 text-sm text-slate-600">
            {open.number} · {billing.cycles.find((entry) => entry.code === open.cycle)?.label} · {channelName({ code: open.channel })}
          </p>
          <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-[auto_1fr] md:items-start">
            {open.qr && <QrImage payload={open.qr} />}
            <div className="space-y-3 text-sm">
              {open.virtualAccount && (
                <div>
                  <p className="text-slate-600">Nomor Virtual Account</p>
                  <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-slate-950">{open.virtualAccount}</p>
                  <Button type="button" variant="outline" className="mt-2" onClick={() => void copy(open.virtualAccount!)} aria-label={`Salin nomor VA ${open.virtualAccount}`}>
                    <Copy className="size-3.5" aria-hidden="true" /> Salin nomor VA
                  </Button>
                </div>
              )}
              {open.paymentUrl && !open.qr && !open.virtualAccount && (
                <a className="btn-primary inline-block" href={open.paymentUrl} target="_blank" rel="noopener noreferrer">Buka halaman pembayaran</a>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-slate-600">Paket</dt>
                <dd className="text-right font-medium text-slate-950">{idr(open.amount)}</dd>
                <dt className="text-slate-600">Biaya layanan pembayaran</dt>
                <dd className="text-right font-medium text-slate-950">{idr(open.adminFee)}</dd>
                <dt className="font-semibold text-slate-950">Total dibayar</dt>
                <dd className="text-right font-semibold text-slate-950">{idr(open.total)}</dd>
              </dl>
              <p className="text-slate-600" aria-live="polite">
                Bayar sebelum <span className="font-medium text-slate-950">{when(open.expiresAt)}</span> · sisa waktu <span className="font-mono font-medium text-slate-950">{countdown}</span>
              </p>
              <Button type="button" onClick={() => void check(open)} disabled={busy !== null}>
                {busy === "check" ? "Mengecek…" : "Cek Status Pembayaran"}
              </Button>
              <p className="text-xs text-slate-500">Pembayaran juga dicek otomatis. Langganan aktif begitu pembayaran terkonfirmasi.</p>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="plansTitle" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h2 id="plansTitle" className="text-base font-semibold text-slate-950">{billing.state === "preview" ? "Aktifkan langganan" : "Perpanjang langganan"}</h2>
        <p className="mt-1 text-sm text-slate-600">Perpanjangan menambah hari dari tanggal berakhir sekarang, jadi sisa hari tidak hilang.</p>
        <fieldset className="mt-4">
          <legend className="sr-only">Pilih paket</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {billing.cycles.map((entry) => {
              const selected = entry.code === cycle;
              const best = entry.code === "12m";
              return (
                <label
                  key={entry.code}
                  className={`relative flex cursor-pointer flex-col gap-1 rounded-xl border p-4 text-sm transition-colors focus-within:ring-2 focus-within:ring-blue-600 ${selected ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
                >
                  <input type="radio" name="cycle" value={entry.code} checked={selected} onChange={() => setCycle(entry.code)} className="sr-only" />
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-950">{entry.label}</span>
                    {best && <Badge>Paling hemat</Badge>}
                  </span>
                  <span className="text-lg font-semibold text-slate-950">{idr(entry.amount)}</span>
                  <span className="text-xs text-slate-600">{entry.days} hari · {CYCLE_NOTES[entry.code]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className="text-sm font-semibold text-slate-950">Metode pembayaran</legend>
          {!billing.configured ? (
            <p className="mt-2 text-sm text-slate-600">Pembayaran langganan belum tersedia. Hubungi admin adsbook.id untuk aktivasi.</p>
          ) : billing.channelError ? (
            <p role="alert" className="mt-2 text-sm text-rose-800">{billing.channelError}</p>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {channels.map((entry) => (
                <label key={entry.code} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-blue-600 ${entry.code === channel ? "border-blue-600 bg-blue-50" : "border-slate-200"}`}>
                  <input type="radio" name="channel" value={entry.code} checked={entry.code === channel} onChange={() => setChannel(entry.code)} className="size-4 accent-blue-600" />
                  <span className="text-slate-950">{channelName(entry)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void create()} disabled={busy !== null || !billing.configured || !channels.some((entry) => entry.code === channel)}>
            <CreditCard className="size-4" aria-hidden="true" />
            {busy === "create" ? "Membuat tagihan…" : `Bayar ${chosenCycle ? idr(chosenCycle.amount) : ""}`}
          </Button>
          {open && <p className="text-xs text-slate-500">Membuat tagihan baru menggantikan tagihan yang sedang menunggu.</p>}
        </div>
      </section>

      <section aria-labelledby="historyTitle" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h2 id="historyTitle" className="text-base font-semibold text-slate-950">Riwayat tagihan</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Belum ada tagihan.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {history.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>
                  <span className="font-medium text-slate-950">{invoice.number}</span>
                  <span className="block text-xs text-slate-500">
                    {billing.cycles.find((entry) => entry.code === invoice.cycle)?.label} · {channelName({ code: invoice.channel })} · {when(invoice.paidAt ?? invoice.createdAt)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-medium text-slate-950">{idr(invoice.total)}</span>
                  <Badge variant={invoice.status === "paid" ? "default" : "outline"}>{STATUS_LABELS[invoice.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
