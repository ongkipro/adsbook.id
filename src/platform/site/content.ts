/**
 * The marketing site's copy (T-40, PR-25), Indonesian, written to the
 * `copywriting` rules: only facts the product and its contracts hold. Each
 * claim names where it comes from, so a change in the product shows here.
 * Screenshots are of the local demo store (demo data), captured 2026-11-16.
 */

/**
 * A product screenshot. Every proof is a phone capture: sellers run their
 * store from a phone, and a phone screen stays readable at any page width
 * (desktop captures shrank to unreadable text in a half-width column).
 */
export type Shot = { src: string; alt: string; width: number; height: number; kind: "phone" };

export const SHOTS = {
  form: { src: "/platform/site/form.webp", alt: "Form order COD di HP: pilih varian, isi nama, nomor WhatsApp dan alamat, lalu ringkasan pesanan", width: 780, height: 1438, kind: "phone" },
  product: { src: "/platform/site/product.webp", alt: "Halaman produk toko di HP: nama produk, harga mulai dan pilihan varian", width: 780, height: 660, kind: "phone" },
  thanks: { src: "/platform/site/thanks.webp", alt: "Halaman pesanan berhasil dibuat yang dilihat pembeli setelah mengisi form", width: 780, height: 880, kind: "phone" },
  orders: { src: "/platform/site/orders.webp", alt: "Pesanan baru di admin: menunggu konfirmasi, dengan risiko RTS penerima belum dinilai", width: 780, height: 555, kind: "phone" },
  shipping: { src: "/platform/site/shipping.webp", alt: "Pesanan yang dirilis ke Mengantar di admin, dengan kurir dan nomor resinya", width: 780, height: 520, kind: "phone" },
  meta: { src: "/platform/site/meta.webp", alt: "Status pencocokan data hash SHA-256 dan deduplikasi event_id browser dan server di admin", width: 706, height: 230, kind: "phone" },
  payments: { src: "/platform/site/payments.webp", alt: "Pengaturan metode pembayaran di admin: COD dan AutoLaris untuk QRIS dan VA, keduanya aktif", width: 780, height: 770, kind: "phone" },
  access: { src: "/platform/site/access.webp", alt: "Akses pengguna di admin: jumlah akun owner, admin, advertiser dan customer service", width: 780, height: 620, kind: "phone" },
  setup: { src: "/platform/site/setup.webp", alt: "Checklist setup toko baru dengan langkah wajib sebelum toko menerima pesanan", width: 780, height: 1280, kind: "phone" },
} satisfies Record<string, Shot>;

/** `buyer`/`seller` are the deeper /cara-kerja view of the same step. */
export type Step = { id: string; label: string; title: string; text: string[]; shot: Shot; buyer: string; seller: string };

/** The five steps of one order — the home page's proof (DESIGN.md C2/C3). */
export const STEPS: Step[] = [
  {
    id: "iklan",
    label: "Iklan",
    title: "Klik iklan mendarat di halaman toko Anda",
    text: [
      "Arahkan iklan ke halaman produk atau landing page toko. Toko langsung aktif di alamat nama-toko.adsbook.my.id, atau di domain Anda sendiri.",
      // middleware.ts: click-id cookie, Max-Age 90 days.
      "ID klik iklan (fbclid, gclid) dan UTM disimpan 90 hari, jadi pesanan yang datang belakangan tetap tersambung ke iklannya.",
    ],
    shot: SHOTS.product,
    buyer: "Mengklik iklan dan membuka halaman produk atau landing page Anda.",
    seller: "Memasang tautan halaman di iklan, lalu Pixel dan tag Google di admin.",
  },
  {
    id: "form",
    label: "Form COD",
    title: "Pembeli isi form singkat, pesanan langsung tercatat",
    text: [
      "Nama, nomor WhatsApp, alamat, lalu kirim. Harga dan berat selalu diambil dari data produk di server, bukan dari browser pembeli.",
      "Bayar di tempat (COD), atau QRIS dan virtual account lewat akun AutoLaris Anda.",
    ],
    shot: SHOTS.thanks,
    buyer: "Memilih varian, mengisi nama, WhatsApp dan alamat. Untuk QRIS atau VA, langsung diarahkan ke pembayaran.",
    seller: "Tidak perlu apa-apa: pesanan tercatat sendiri, termasuk form yang tidak selesai sebagai lead.",
  },
  {
    id: "pesanan",
    label: "Pesanan masuk",
    title: "Semua pesanan menunggu keputusan Anda",
    text: [
      // AGENTS §3: checkout never dispatches; orders land as pending.
      "Pesanan masuk dengan status menunggu. Tidak ada yang langsung dikirim: Anda atau tim CS memeriksa alamat dan risiko penerima, lalu memutuskan.",
      "Form yang tidak selesai tersimpan sebagai lead untuk ditindaklanjuti CS, lalu terhapus sendiri setelah 14 hari.",
    ],
    shot: SHOTS.orders,
    buyer: "Menunggu konfirmasi dari CS Anda lewat WhatsApp.",
    seller: "Memeriksa alamat dan risiko RTS penerima, menghubungi pembeli bila perlu, lalu memproses pesanan.",
  },
  {
    id: "kirim",
    label: "Kirim kurir",
    title: "Rilis ke kurir dari admin, resi tersimpan",
    text: [
      "Kirim pesanan lewat akun Mengantar Anda, satu per satu atau sekaligus. Resi, jadwal pickup dan status kiriman tersimpan di pesanan.",
    ],
    shot: SHOTS.shipping,
    buyer: "Bisa membuka status pesanannya lewat tautan dari toko Anda.",
    seller: "Merilis pesanan ke Mengantar, lalu menjadwalkan pickup atau mengantar ke counter.",
  },
  {
    id: "purchase",
    label: "Purchase ke Meta",
    title: "Penjualan sampai ke Meta, walau pembeli langsung menutup halaman",
    text: [
      // ADR-036: every Purchase-qualifying order is sent from the server.
      "Setiap pesanan COD mengirim Purchase dari server ke Conversions API, dengan event_id yang sama seperti Pixel di browser, jadi tidak dobel dan tidak hilang.",
      "Data pembeli di-hash SHA-256 sebelum dikirim. Konversi offline Google Ads juga bisa diaktifkan.",
    ],
    shot: SHOTS.meta,
    buyer: "Tidak melihat apa-apa: semuanya terjadi di server.",
    seller: "Melihat penjualan di Meta Ads Manager: COD saat pesanan dibuat, QRIS dan VA saat lunas.",
  },
];

/**
 * Option A (ADR-041), the same cycles `src/platform/billing.ts` bills; the
 * limits are the plan row (PLATFORM_DB.plans, migration 0005). No number here
 * that the product does not enforce.
 */
export const PLANS = [
  { code: "1m", label: "1 Bulan", price: "Rp149.000", period: "30 hari", note: "Fleksibel, perpanjang tiap bulan" },
  { code: "3m", label: "3 Bulan", price: "Rp399.000", period: "90 hari", note: "Hemat Rp48.000" },
  { code: "6m", label: "6 Bulan", price: "Rp759.000", period: "180 hari", note: "Hemat Rp135.000" },
  { code: "12m", label: "1 Tahun", price: "Rp1.490.000", period: "365 hari", note: "Bayar 10 bulan, gratis 2 bulan", best: true },
] as const;

export const PLAN_POINTS = [
  "1 toko di nama-toko.adsbook.my.id, plus 1 domain sendiri",
  "Pixel dan Conversions API Meta dengan satu event_id per pesanan",
  "Konversi offline Google Ads dari pesanan yang benar-benar terjadi",
  "0% potongan per transaksi: uang pembeli langsung ke akun Anda",
  "Produk dan pesanan tanpa batas; 60 unggahan foto dan 20 draf AI per jam",
];

export const PREVIEW = {
  title: "Coba buat toko gratis, bayar saat siap beriklan",
  text: "Daftar tanpa kartu. Di Mode Preview Anda bisa menyiapkan produk, landing page, gudang, dan pengaturan pixel, lalu melihat toko seperti pembeli melihatnya. Pesanan pembeli, sinyal iklan, AI, dan domain sendiri aktif begitu langganan dibayar.",
  payment: "Bayar langganan dengan QRIS atau Virtual Account (BCA, Mandiri, BNI, BRI, Permata). Perpanjangan menambah hari dari tanggal berakhir, jadi sisa hari tidak hilang.",
  grace: "Lewat jatuh tempo, toko tetap jalan 48 jam agar iklan tidak terhenti mendadak. Setelah itu pesanan dan iklan dijeda, data toko tetap aman, dan Anda tetap bisa masuk ke admin untuk memperpanjang.",
  fees: "Biaya kurir dan pembayaran pembeli ditagih Mengantar dan AutoLaris langsung ke akun Anda.",
};

export type Faq = { q: string; a: string };

export const FAQ_SHORT: Faq[] = [
  { q: "Apakah gratis?", a: "Membuat toko dan menyiapkannya gratis di Mode Preview, tanpa kartu. Saat toko siap menerima pesanan dan diiklankan, berlangganan mulai Rp149.000 per bulan, atau Rp1.490.000 per tahun (bayar 10 bulan, gratis 2 bulan). Tidak ada potongan per transaksi." },
  { q: "Apa maksud deduplikasi sinyal iklan 1:1?", a: "Satu pesanan dikirim ke Meta dari browser (Pixel) dan dari server (Conversions API) dengan event_id yang sama, jadi Meta menghitungnya satu kali, bukan dua. Purchase dari server tetap terkirim walau pembeli langsung menutup halaman, dengan 8 data pembeli yang di-hash SHA-256 untuk pencocokan." },
  { q: "Uang pembeli masuk ke mana?", a: "Ke akun Anda. COD dicairkan oleh Mengantar, QRIS dan VA oleh AutoLaris, keduanya ke akun Anda sendiri. adsbook.id tidak memegang dana pembeli dan tidak memotong per transaksi." },
  { q: "Bisa pakai domain sendiri?", a: "Bisa, 1 domain sendiri per toko yang berlangganan. Untuk domain lain, buka toko baru. Domain utama (contoh.com) bisa dipakai bila DNS Anda mendukung CNAME di root; kalau tidak, pakai www." },
  { q: "Apa saja yang perlu disiapkan?", a: "Satu produk dengan harga dan berat, gudang utama dengan alamat pickup, dan API key Mengantar. Sampai semua langkah wajib selesai, pembeli melihat halaman \"Toko belum siap\" dan belum bisa memesan." },
];

export const FAQ_MORE: Faq[] = [
  { q: "Apa yang terjadi kalau langganan habis?", a: "Toko tetap jalan 48 jam setelah jatuh tempo. Setelah itu pesanan, iklan, dan AI dijeda, data toko tetap utuh, dan Anda tetap bisa masuk ke admin untuk memperpanjang; toko langsung aktif lagi begitu pembayaran masuk." },
  { q: "Bayar langganan pakai apa?", a: "QRIS atau Virtual Account BCA, Mandiri, BNI, BRI, dan Permata, langsung dari menu Langganan di admin toko." },
  { q: "Siapa pemilik data pembeli?", a: "Anda. Kami memprosesnya hanya untuk menjalankan toko Anda. Data tiap toko terpisah dan bisa Anda ekspor dari admin." },
  { q: "Apakah ada aplikasi yang harus dipasang?", a: "Tidak. Toko dan admin berjalan di browser, termasuk di HP." },
  { q: "Bisa dipakai bersama tim?", a: "Bisa. Tambahkan akun untuk admin, advertiser, dan customer service; tiap peran hanya melihat menu yang ia perlukan." },
  { q: "Kalau pembeli tidak membuka halaman terima kasih, apakah konversinya hilang?", a: "Tidak. Purchase dikirim dari server saat pesanan COD dibuat atau saat pembayaran lunas, jadi tidak bergantung pada halaman terima kasih." },
  { q: "Bagaimana kalau saya ingin berhenti?", a: "Minta penghapusan toko dari admin. Data toko dihapus 30 hari setelah permintaan; selama itu Anda masih bisa membatalkannya." },
  { q: "Di mana data toko disimpan?", a: "Di Cloudflare dengan penyimpanan diutamakan di Asia-Pasifik; pemrosesan dapat berlangsung di jaringan global Cloudflare. Rinciannya ada di Kebijakan Privasi." },
];

/** Feature groups for /fitur: each line is something the product does today. */
export const FEATURES: Array<{ title: string; items: string[]; shot: Shot }> = [
  { title: "Deduplikasi sinyal iklan 1:1", items: ["Pixel dan Conversions API Meta mengirim satu pesanan dengan event_id yang sama: dihitung satu kali, bukan dua", "Purchase dari server untuk setiap pesanan COD, walau pembeli langsung menutup halaman", "8 data pembeli di-hash SHA-256 untuk pencocokan, plus ID klik dan UTM yang disimpan 90 hari", "Konversi offline Google Ads dan ID produk yang sama di feed katalog dan event"], shot: SHOTS.meta },
  { title: "Toko dan form order", items: ["Halaman produk dan landing page dengan form order di dalamnya", "Form embed untuk dipasang di halaman lain", "Harga, varian dan berat dari data produk di server", "Draf konten produk dengan AI, Anda yang menerbitkan"], shot: SHOTS.form },
  { title: "Pesanan", items: ["Semua pesanan masuk sebagai menunggu, tidak ada yang terkirim sendiri", "Cek risiko RTS penerima sebelum dikirim", "Lead dari form yang tidak selesai untuk ditindaklanjuti CS", "Ekspor pesanan ke CSV"], shot: SHOTS.orders },
  { title: "Pengiriman", items: ["Ongkir dihitung lewat Mengantar dari gudang Anda", "Rilis ke kurir satu per satu atau sekaligus", "Resi, pickup dan status kiriman di satu halaman", "Sampai 10 gudang: gudang di provinsi pembeli dipakai lebih dulu, lalu gudang satu pulau, lalu gudang utama"], shot: SHOTS.shipping },
  { title: "Pembayaran", items: ["COD", "QRIS dan virtual account lewat akun AutoLaris Anda", "Transfer ke rekening toko dengan konfirmasi manual", "Rekonsiliasi pembayaran otomatis untuk QRIS dan VA"], shot: SHOTS.payments },
  { title: "Toko Anda, akun Anda", items: ["Alamat nama-toko.adsbook.my.id, plus 1 domain sendiri", "Akun tim dengan peran owner, admin, advertiser dan CS", "API untuk menghubungkan toko dengan aplikasi Anda sendiri", "Kebijakan privasi toko yang menyebut hanya penyedia yang Anda pakai"], shot: SHOTS.access },
];

/** The setup steps a new store sees (the readiness predicate, T-38), for the closing band. */
export const SETUP_STEPS = ["Tambah produk pertama dengan harga dan berat", "Lengkapi gudang utama dan alamat pickup", "Simpan API key Mengantar Anda"];
/** What signup already completes (identity, couriers on, COD on): the other three of six. */
export const SETUP_DONE = "Nama toko, kurir, dan COD sudah siap sejak Anda mendaftar.";

/**
 * The sales page (/coba): six flagship features, each a fact the product holds
 * today (content/adsbook-id-sales-lp/features.md §2, checked against the code
 * 2026-11-17). Infrastructure figures are the provider's published ones, named
 * without the vendor (Paduka, 2026-11-17).
 */
export type SalesFlagship = {
  kicker: string;
  title: string;
  points: string[];
  shot?: Shot;
  specs?: Array<{ value: string; label: string }>;
};

export const SALES_FLAGSHIPS: SalesFlagship[] = [
  {
    kicker: "Sinyal iklan 1:1",
    title: "Satu pesanan, satu Purchase. Tidak dobel, tidak hilang",
    points: [
      "Pixel di browser dan Conversions API dari server memakai event_id yang sama untuk setiap pesanan",
      "Purchase dikirim dari server saat pesanan COD dibuat atau saat pembayaran lunas",
      "8 data pembeli di-hash SHA-256 untuk pencocokan, ID klik dan UTM disimpan 90 hari",
      "Konversi offline Google Ads dari pesanan yang benar-benar terjadi",
    ],
    shot: SHOTS.meta,
  },
  {
    kicker: "Form COD",
    title: "Form cepat di HP, yang tidak selesai pun jadi lead",
    points: [
      "Form singkat, lengkap, atau hybrid dengan ongkir per kecamatan",
      "Form di halaman produk dan landing page, atau dipasang di situs lain",
      "Harga, varian, dan berat selalu dari data toko, bukan dari browser",
      "Form yang tidak selesai masuk Pesanan tertinggal untuk di-follow up CS, dengan hingga 10 nomor WhatsApp CS bergiliran",
    ],
    shot: SHOTS.form,
  },
  {
    kicker: "Kontrol RTS",
    title: "Anda yang memutuskan apa yang dikirim",
    points: [
      "Tidak ada pesanan yang terkirim sendiri: semua masuk sebagai menunggu",
      "Cek risiko RTS penerima sebelum dikirim",
      "Rilis ke kurir satu per satu atau sekaligus, resi dan pickup di satu halaman",
      "Hingga 10 gudang: gudang di provinsi pembeli dipakai lebih dulu",
    ],
    shot: SHOTS.orders,
  },
  {
    kicker: "Akun Anda sendiri",
    title: "Uang pembeli langsung ke akun Anda",
    points: [
      "0% potongan per transaksi dari adsbook.id",
      "COD lewat Mengantar, QRIS dan Virtual Account lewat AutoLaris, keduanya akun Anda",
      "QRIS dan VA aktif cukup dengan API key AutoLaris",
      "Rekonsiliasi pembayaran QRIS dan VA otomatis",
    ],
    shot: SHOTS.payments,
  },
  {
    kicker: "Mulai gratis",
    title: "Siapkan toko gratis, buka saat siap beriklan",
    points: [
      "Toko aktif di nama-toko.adsbook.my.id sejak Anda mendaftar, tanpa kartu",
      "Mode Preview: Anda melihat toko seperti pembeli, pembeli melihat toko belum siap",
      "Checklist menunjukkan tiga langkah yang tersisa",
      "Lewat jatuh tempo, toko tetap jalan 48 jam agar iklan tidak berhenti mendadak",
    ],
    shot: SHOTS.setup,
  },
  {
    kicker: "Infrastruktur",
    title: "Cepat di mana pun pembeli Anda, terpisah untuk setiap toko",
    points: [
      "Dilayani dari jaringan edge global, dengan database sendiri untuk setiap toko di Asia-Pasifik",
      "Backup harian dan SSL otomatis, termasuk untuk domain sendiri",
    ],
    specs: [
      { value: "348 kota", label: "jaringan edge di 100+ negara" },
      { value: "50 ms", label: "dari 95% pengguna internet dunia" },
      { value: "10 GB", label: "database sendiri per toko" },
      { value: "1.000/dtk", label: "permintaan per toko" },
    ],
  },
];

export const SALES_SUPPORT: Array<{ title: string; text: string }> = [
  { title: "Domain sendiri", text: "Satu record CNAME, SSL otomatis, dan bisa diganti kapan saja." },
  { title: "Landing page", text: "Buat dari admin, dengan form order di dalamnya." },
  { title: "Katalog dan feed", text: "Varian dan foto; feed Google Merchant dan katalog Meta terisi otomatis." },
  { title: "Analitik dari pesanan", text: "Omzet, funnel, produk, landing page, lokasi, jam beli, dan UTM." },
  { title: "Link UTM", text: "Buat link iklan bertanda UTM, lalu bandingkan hasil per kampanye." },
  { title: "Tim dengan peran", text: "Owner, admin, advertiser, dan CS hanya melihat menu tugasnya." },
  { title: "Draf konten AI", text: "Draf deskripsi produk dengan AI; Anda yang menerbitkan." },
  { title: "Template CRM", text: "Pesan WhatsApp dengan nama, produk, dan data pesanan terisi." },
  { title: "API dan CLI", text: "REST API untuk frontend sendiri, Operations API dan CLI untuk skrip." },
];
