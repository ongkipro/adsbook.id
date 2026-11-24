import { ChevronDown, CircleCheck } from "lucide-react";
import { CMS_VERSION } from "@/lib/version";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ChangelogItem {
  title: string;
  description: string;
}

interface ChangelogRelease {
  version: string;
  date: string;
  releaseTag?: string;
  isLatest?: boolean;
  highlight: string;
  changes: ChangelogItem[];
}

// Written from the repository's own record (git history, RELEASE.md, BUILD-LOG)
// — an operator reads this as fact. The first entry is the running version:
// changelog.test.ts fails when version.ts moves without a matching entry here.
// adsbook.id starts its own history at 1.0.0 (Paduka, 2026-11-17): the
// releases of the engine it was forked from described a different product and are kept in
// the repository's history, not here. The first entry is the running version:
// changelog.test.ts fails when version.ts moves without a matching entry here.
const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    version: "1.0.0",
    date: "17 November 2026",
    releaseTag: "2026.11-launch",
    isLatest: true,
    highlight: "Rilis pertama adsbook.id: jual produk fisik dan digital, kelola pesanan dari satu dashboard, dan kirim data konversi ke Meta, Google, dan TikTok.",
    changes: [
      {
        title: "Daftar toko dan masuk dari satu tempat",
        description: "Pilih jenis produk dan alamat toko, lalu isi nama toko dan kontak pemilik. Masuk melalui adsbook.id/masuk dengan email pemilik atau username akun tim.",
      },
      {
        title: "Mode Preview gratis, bayar saat siap beriklan",
        description: "Siapkan produk, landing page, gudang, dan pixel tanpa biaya. Pesanan pembeli, sinyal iklan, AI, dan domain sendiri aktif setelah berlangganan, mulai Rp149.000/bulan lewat QRIS atau Virtual Account. Lewat jatuh tempo ada masa tenggang 48 jam.",
      },
      {
        title: "Tracking konversi untuk Meta, Google, dan TikTok",
        description: "Hubungkan akun iklan untuk mengirim data konversi dari toko. Sinyal browser dan server untuk Meta dan TikTok memakai ID yang sama agar platform dapat mengenali event ganda. Google Ads mendukung Data Manager API sesuai konfigurasi.",
      },
      {
        title: "Checkout untuk produk fisik dan digital",
        description: "Produk fisik mendukung COD dan ongkir per kecamatan sesuai pengaturan. Akses produk digital dibuka setelah pembayaran lunas. Aktifkan Mode Hybrid di pengaturan toko untuk menjual keduanya.",
      },
      {
        title: "Pengiriman lewat Mengantar, rilis dari admin",
        description: "Pesanan masuk dengan status menunggu; Anda yang memutuskan kapan dirilis ke kurir. Resi tersimpan otomatis, banyak gudang didukung, dan pickup atau drop-off bisa dipilih.",
      },
      {
        title: "Transfer bank, QRIS, dan Virtual Account",
        description: "Tambahkan rekening untuk transfer manual, atau hubungkan AutoLaris untuk QRIS dan Virtual Account yang aktif. Adsbook.id tidak mengambil komisi per transaksi; biaya penyedia pembayaran atau kurir tetap berlaku.",
      },
      {
        title: "Gunakan domain sendiri",
        description: "Setelah berlangganan, hubungkan domain toko dari Pengaturan dan ikuti petunjuk DNS yang ditampilkan. Jadikan domain itu alamat utama setelah statusnya aktif.",
      },
      {
        title: "Landing page, katalog, dan feed produk",
        description: "Buat landing page dan kelola varian serta foto produk dari admin. Gunakan feed toko untuk katalog Meta, Google Merchant Center, dan TikTok.",
      },
      {
        title: "Analitik dari pesanan, bukan tebakan",
        description: "Dashboard omzet dan funnel, analitik per produk, landing page, lokasi, jam, dan UTM, serta daftar yang perlu ditindak hari ini.",
      },
      {
        title: "Tim dengan peran masing-masing",
        description: "Owner, admin, CS, dan advertiser masing-masing hanya melihat menu yang menjadi tugasnya.",
      },

    ],
  },
];

interface ChangelogModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * One release's changes, the same list for the running release and for an
 * opened earlier one: a check, the title on its own line, the explanation
 * under it, a hairline between items.
 */
function ChangeList({ changes, compact = false }: { changes: ChangelogRelease["changes"]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100">
      {changes.map((item, idx) => (
        <li key={idx} className={`flex gap-3 ${compact ? "py-2.5" : "py-3"} first:pt-1 last:pb-0`}>
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <div className="min-w-0">
            <p className={`${compact ? "text-xs" : "text-sm"} font-medium leading-5 text-slate-900`}>{item.title}</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">{item.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChangelogModal({ open, onOpenChange }: ChangelogModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl md:max-w-2xl">
        <DialogHeader className="border-b border-slate-200 px-6 py-4 text-left">
          <div className="flex items-center justify-between pr-8">
            <DialogTitle className="text-base font-semibold text-slate-950">
              What's new
            </DialogTitle>
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs font-medium text-slate-600">
              v{CMS_VERSION.version}
            </span>
          </div>
          <DialogDescription className="text-xs text-slate-500">
            Apa yang berubah di setiap versi adsbook.id.
          </DialogDescription>
        </DialogHeader>

        {/* The running release in full; every earlier one a single line that
            opens in place. Forty releases expanded at once read as one wall
            of text (Paduka, 2026-11-01). */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {CHANGELOG_RELEASES.slice(0, 1).map((rel) => (
            <section key={rel.version} aria-labelledby={`release-${rel.version}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 id={`release-${rel.version}`} className="font-mono text-sm font-semibold text-slate-950">v{rel.version}</h3>
                {rel.isLatest && <span className="rounded bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white">Aktif</span>}
                <time className="text-xs text-slate-500">{rel.date}</time>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-800">{rel.highlight}</p>
              <div className="mt-3"><ChangeList changes={rel.changes} /></div>
            </section>
          ))}

          {CHANGELOG_RELEASES.length > 1 && (
            <section className="mt-6" aria-labelledby="release-history">
              <h3 id="release-history" className="text-xs font-semibold uppercase tracking-wider text-slate-500">Versi sebelumnya</h3>
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {CHANGELOG_RELEASES.slice(1).map((rel) => (
                  <li key={rel.version}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-start gap-3 px-3.5 py-3 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="font-mono text-xs font-semibold text-slate-900">v{rel.version}</span>
                            <time className="text-xs text-slate-400">{rel.date}</time>
                          </span>
                          <span className="mt-0.5 block truncate text-xs leading-5 text-slate-600 group-open:whitespace-normal">{rel.highlight}</span>
                        </span>
                        <ChevronDown className="mt-0.5 size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
                      </summary>
                      <div className="border-t border-slate-100 bg-slate-50/50 px-3.5 pb-3 pt-2">
                        <ChangeList changes={rel.changes} compact />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <DialogFooter className="m-0 rounded-none border-t border-slate-200 bg-slate-50/70 px-6 py-3 sm:flex sm:items-center sm:justify-between">
          <div className="text-xs font-mono text-slate-500">
            {CMS_VERSION.coreEngine} · skema v{CMS_VERSION.schemaVersion}
          </div>
          <DialogClose render={<Button variant="outline" size="sm" type="button" />}>Tutup</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
