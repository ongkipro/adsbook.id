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
  form: { src: "/platform/site/form.webp", alt: "Form order COD di HP: pilih varian, isi nama, nomor WhatsApp dan alamat, lalu ringkasan pesanan", width: 780, height: 1766, kind: "phone" },
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
      "ID klik Meta dan Google serta UTM dari kanal mana pun (TikTok dan jaringan lain) disimpan 90 hari, jadi pesanan yang datang belakangan tetap tersambung ke iklannya.",
    ],
    shot: SHOTS.product,
    buyer: "Mengklik iklan dan membuka halaman produk atau landing page Anda.",
    seller: "Memasang tautan halaman di iklan (Link UTM untuk kanal mana pun), lalu Pixel Meta dan tag Google di admin.",
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
    label: "Konversi tercatat",
    title: "Penjualan sampai ke jaringan iklan, walau pembeli langsung menutup halaman",
    text: [
      // ADR-036: every Purchase-qualifying order is sent from the server.
      "Setiap pesanan COD mengirim Purchase dari server ke Conversions API, dengan event_id yang sama seperti Pixel di browser, jadi tidak dobel dan tidak hilang.",
      "Konversi offline Google Ads dari pesanan yang benar-benar terjadi. Data pembeli di-hash SHA-256 sebelum dikirim, dan setiap pesanan tercatat ke kanalnya di Analitik.",
    ],
    shot: SHOTS.meta,
    buyer: "Tidak melihat apa-apa: semuanya terjadi di server.",
    seller: "Melihat penjualan di Meta Ads Manager dan Google Ads, dan semua kanal di Analitik: COD saat pesanan dibuat, QRIS dan VA saat lunas.",
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
  "Semua kanal iklan tercatat per sumber dan kampanye: Meta, Google, TikTok, dan lainnya",
  "Konversi 1:1 ke Meta (Pixel + Conversions API) dan Google Ads (tag + konversi offline)",
  "0% potongan per transaksi: uang pembeli langsung ke akun Anda",
  "Produk dan pesanan tanpa batas; 60 unggahan foto dan 20 draf AI per jam",
];

export const PREVIEW = {
  title: "Gratis sampai siap beriklan",
  text: "Daftar tanpa kartu. Di Mode Preview Anda bisa menyiapkan produk, landing page, gudang, dan pengaturan pixel, lalu melihat toko seperti pembeli melihatnya. Pesanan pembeli, sinyal iklan, AI, dan domain sendiri aktif begitu langganan dibayar.",
  payment: "Bayar langganan dengan QRIS atau Virtual Account (BCA, Mandiri, BNI, BRI, Permata). Perpanjangan menambah hari dari tanggal berakhir, jadi sisa hari tidak hilang.",
  grace: "Lewat jatuh tempo, toko tetap jalan 48 jam agar iklan tidak terhenti mendadak. Setelah itu pesanan dan iklan dijeda, data toko tetap aman, dan Anda tetap bisa masuk ke admin untuk memperpanjang.",
  fees: "Biaya kurir dan pembayaran pembeli ditagih Mengantar dan AutoLaris langsung ke akun Anda.",
};

export type Faq = { q: string; a: string };

export const FAQ_SHORT: Faq[] = [
  { q: "Bagaimana Hybrid Form mencegah iklan bocor ke provinsi rawan retur?", a: "Saat mode Hybrid aktif, pembeli di wilayah target langsung mendapat form COD singkat yang cepat. Sedangkan pengunjung dari provinsi yang Anda kecualikan (misalnya Papua, Maluku, NTT, atau NTB) otomatis dialihkan ke form penuh Non-COD dengan QRIS/VA dan ongkir kecamatan. Dashboard iklan Anda tidak dikotori konversi COD dari luar area target, arah learning tetap fokus di wilayah sehat, dan pesanan yang masuk dari luar area sudah lunas bebas retur." },
  { q: "Apa bedanya mesin sinyal 1:1 di sini dibanding pasang Pixel atau CAPI biasa?", a: "Pixel browser sering terhalang pemblokir iklan, privasi iOS, atau pembeli yang langsung menutup layar. Sebaliknya, CAPI tanpa ID kembar bisa membuat satu pesanan terhitung dua konversi. Di adsbook.id, jejak klik disimpan 90 hari sebagai data first-party (tidak terhapus oleh link follow-up WhatsApp CS), diperkaya 8 kunci identitas SHA-256, dan dikirim dari browser serta server dengan satu ID pesanan ke Meta Ads dan Google Ads tanpa sewa server GTM tambahan." },
  { q: "Benarkah 0% potongan transaksi QRIS/VA dan tanpa kuota order bulanan?", a: "Benar. COD dicairkan oleh Mengantar, sedangkan QRIS dan Virtual Account oleh AutoLaris langsung ke akun milik Anda sendiri. adsbook.id tidak memegang dana penjualan, tidak memotong komisi persentase per transaksi, dan tidak membatasi kuota order maupun jumlah produk." },
  { q: "Bisa rakit dan review tampilan toko gratis dulu sebelum bayar?", a: "Bisa, tanpa kartu di Mode Preview. Setelah toko siap menerima pesanan iklan, aktifkan langganan mulai Rp149.000 per bulan atau Rp1.490.000 per tahun (bayar 10 bulan, gratis 2 bulan)." },
  { q: "Satu toko dapat domain sendiri, dan bagaimana pelacakan iklan TikTok?", a: "Setiap 1 langganan mencakup 1 toko dan 1 domain sendiri dengan SSL otomatis. Untuk TikTok dan platform iklan lain, buat tautan kampanye di menu Link UTM agar setiap pesanan dan omzet tercatat rapi per kampanye di dashboard Analitik toko." },
];

export const FAQ_MORE: Faq[] = [
  { q: "Bagaimana sistem ini membantu ROAS, dan amankah untuk akun iklan saya?", a: "Dashboard iklan mengoptimasi kampanye dari konversi yang ia terima. Saat sinyal bocor hilang dan konversi terhitung ganda dihentikan, budget berhenti tersedot ke kampanye semu dan fokus mendorong kampanye yang benar-benar menjual. Hasil ROAS tetap ditentukan produk, iklan, dan pasar Anda. Sinyal dikirim ke Pixel resmi milik Anda lewat API standar Meta dan Google." },
  { q: "Apa saja yang perlu disiapkan?", a: "Satu produk dengan harga dan berat, gudang utama dengan alamat pickup, dan API key Mengantar. Sampai semua langkah wajib selesai, pembeli melihat halaman \"Toko belum siap\" dan belum bisa memesan." },
  { q: "Apa yang terjadi kalau langganan habis?", a: "Toko tetap jalan 48 jam setelah jatuh tempo. Setelah itu pesanan, iklan, dan AI dijeda, data toko tetap utuh, dan Anda tetap bisa masuk ke admin untuk memperpanjang; toko langsung aktif lagi begitu pembayaran masuk." },
  { q: "Bayar langganan pakai apa?", a: "QRIS atau Virtual Account BCA, Mandiri, BNI, BRI, dan Permata, langsung dari menu Langganan di admin toko." },
  { q: "Siapa pemilik data pembeli?", a: "Anda. Kami memprosesnya hanya untuk menjalankan toko Anda. Data tiap toko terpisah dan bisa Anda ekspor dari admin." },
  { q: "Apakah ada aplikasi yang harus dipasang?", a: "Tidak. Toko dan admin berjalan di browser, termasuk di HP." },
  { q: "Bisa dipakai bersama tim?", a: "Bisa. Tambahkan akun untuk admin, advertiser, dan customer service; tiap peran hanya melihat menu yang ia perlukan." },
  { q: "Kalau pembeli tidak membuka halaman terima kasih, apakah konversinya hilang?", a: "Tidak. Purchase dikirim dari server saat pesanan COD dibuat atau saat pembayaran lunas, jadi tidak bergantung pada halaman terima kasih." },
  { q: "Saya beriklan di TikTok atau jaringan lain. Apakah tercatat?", a: "Ya. Buat link iklan dengan Link UTM di admin, lalu setiap pesanan tercatat per sumber dan kampanye di Analitik, sama seperti Meta dan Google. Sinyal konversi dari server saat ini dikirim ke Meta dan Google Ads." },
  { q: "Bagaimana kalau saya ingin berhenti?", a: "Minta penghapusan toko dari admin. Data toko dihapus 30 hari setelah permintaan; selama itu Anda masih bisa membatalkannya." },
  { q: "Di mana data toko disimpan?", a: "Setiap toko punya database sendiri, diutamakan berada di Asia-Pasifik, dengan backup harian; pemrosesan dapat berlangsung di jaringan edge global penyedia infrastruktur kami. Nama penyedia dan rinciannya ada di Kebijakan Privasi." },
];

/** The setup steps a new store sees (the readiness predicate, T-38), for the closing band. */
export const SETUP_STEPS = ["Tambah produk pertama dengan harga dan berat", "Lengkapi gudang utama dan alamat pickup", "Simpan API key Mengantar Anda"];
/** What signup already completes (identity, couriers on, COD on): the other three of six. */
export const SETUP_DONE = "Nama toko, kurir, dan COD sudah siap sejak Anda mendaftar.";

/**
 * One vocabulary for every page (2026-11-17 site pass): the promise is
 * "presisi" — one order, one Purchase — and every page says it the same way.
 * Each pillar is a fact the product holds today (content/adsbook-id-sales-lp/
 * features.md §2, checked against the code). The home shows the pillars short;
 * /fitur shows them in full, with their screen or their numbers. Infrastructure
 * figures are the provider's published ones, named without the vendor.
 */
export type Pillar = {
  id: string;
  label: string;
  title: string;
  summary: string;
  points: string[];
  shot?: Shot;
  specs?: Array<{ value: string; label: string }>;
};

export const PILLARS: Pillar[] = [
  {
    id: "sinyal",
    label: "Sinyal 1:1 & Dashboard Iklan",
    title: "Konversi utuh ke dashboard iklan, bebas bocor & bebas ganda",
    summary: "TikTok dan sumber lain terlacak 90 hari di Analitik. Meta dan Google menerima 1 ID kembar dari browser dan server.",
    points: [
      // src/lib/click-ids.ts: a later UTM-only visit (a WhatsApp follow-up link) keeps the stored click id.
      "Jejak first-party 90 hari: ID klik Meta dan Google, plus UTM TikTok dan sumber lain; link follow-up WhatsApp dari CS tidak menghapusnya",
      // src/lib/meta-identity.ts: ph (08 → 628), fn, ln, ct, st, zp, country, external_id.
      "8 data pembeli di-hash SHA-256 sebelum dikirim: nomor WhatsApp dinormalkan ke 628, nama, kota, provinsi, kode pos, negara, dan ID pengunjung",
      "Deduplikasi 1:1: Meta Pixel dan Conversions API dengan event_id yang sama; Google Ads menerima tag konversi dan konversi offline dari pesanan nyata",
      "Dari server saat pesanan COD dibuat atau lunas, walau pembeli langsung menutup halaman; tanpa server GTM atau aplikasi tracker terpisah",
    ],
    shot: SHOTS.meta,
  },
  {
    id: "form",
    label: "Hybrid Form & Lead CS",
    title: "Saring provinsi otomatis, kecamatan 0 ms & tangkap lead gantung",
    summary: "Area target dapat form COD cepat, area jauh dialihkan ke QRIS/VA, dan yang batal isi tetap masuk antrean CS.",
    points: [
      "Hybrid Form berbasis provinsi: form COD singkat untuk wilayah target, otomatis alihkan ke Non-COD (QRIS/VA + ongkir) di provinsi yang dikecualikan",
      "Pencarian 7.285 kecamatan instan di browser tanpa tunggu server; bisa dipasang di halaman toko, landing page, atau situs luar",
      "Harga, varian, dan berat selalu dikunci dari server toko, mustahil dimanipulasi dari browser pembeli",
      "Form yang tidak selesai masuk Pesanan tertinggal; hingga 10 nomor WhatsApp CS bergiliran otomatis",
    ],
    shot: SHOTS.form,
  },
  {
    id: "kirim",
    label: "Rem Anti-RTS",
    title: "Cek skor RTS penerima dulu sebelum paket dikirim",
    summary: "Semua pesanan masuk status menunggu; pilih otomatis dari 10 titik gudang terdekat.",
    points: [
      "Tidak ada pesanan yang terkirim sendiri: semua masuk sebagai menunggu",
      "Cek risiko RTS penerima sebelum dikirim",
      "Rilis ke kurir satu per satu atau sekaligus; resi dan pickup di satu halaman",
      "Hingga 10 gudang: gudang di provinsi pembeli dipakai lebih dulu",
    ],
    shot: SHOTS.orders,
  },
  {
    id: "uang",
    label: "0% Komisi Transaksi",
    title: "Dana cair langsung ke akun Anda, tanpa kuota order",
    summary: "COD lewat Mengantar, QRIS & VA lewat AutoLaris milik Anda sendiri — 0% potongan dari kami.",
    points: [
      "0% potongan per transaksi dari adsbook.id dan tanpa batasan kuota order bulanan",
      "COD lewat Mengantar, QRIS dan Virtual Account lewat AutoLaris, keduanya akun Anda",
      "QRIS dan VA aktif cukup dengan API key AutoLaris; rekonsiliasi otomatis",
      "Data pembeli milik Anda, terpisah per toko, dan bisa diekspor",
    ],
    shot: SHOTS.payments,
  },
  {
    id: "mulai",
    label: "Review Toko Gratis",
    title: "Rakit toko tanpa biaya, dilindungi masa tenggang 48 jam",
    summary: "Tata produk & cek tampilan di HP tanpa kartu; bayar mulai Rp149rb hanya saat siap jalan iklan.",
    points: [
      "Toko aktif di nama-toko.adsbook.my.id sejak mendaftar, tanpa kartu",
      "Mode Review Pemilik: Anda mengecek tampilan asli toko di HP seperti pembeli, sementara pengunjung melihat toko sedang disiapkan",
      "Checklist menunjukkan tiga langkah yang tersisa",
      "Lewat jatuh tempo, toko tetap jalan 48 jam agar iklan tidak berhenti mendadak",
    ],
    shot: SHOTS.setup,
  },
  {
    id: "infra",
    label: "Database Mandiri",
    title: "10 GB database terpisah per toko di jaringan cepat",
    summary: "Toko lain sedang banjir trafik, kecepatan form checkout toko Anda tidak ikut melambat.",
    points: [
      "Dilayani dari jaringan edge global, dengan database sendiri untuk setiap toko di Asia-Pasifik",
      "Backup harian dan SSL otomatis, termasuk untuk domain sendiri",
    ],
    specs: [
      { value: "348", label: "kota jaringan edge, di 100+ negara" },
      { value: "50 ms", label: "dari 95% pengguna internet dunia" },
      { value: "10 GB", label: "database sendiri per toko" },
      { value: "1.000/dtk", label: "permintaan per toko" },
    ],
  },
];

/** Everything else a store runs on, one line each (/fitur and the home). */
export const CAPABILITIES: Array<{ title: string; text: string }> = [
  { title: "Domain sendiri", text: "Satu record CNAME, SSL otomatis, dan bisa diganti kapan saja." },
  { title: "Landing page", text: "Dibuat dari admin, dengan form order di dalamnya." },
  { title: "Katalog dan feed", text: "Varian dan foto; feed Google Merchant dan katalog Meta terisi otomatis." },
  { title: "Analitik per kanal", text: "Omzet dan pesanan per kanal iklan, kampanye, produk, landing page, lokasi, dan jam beli." },
  { title: "Link UTM", text: "Link iklan bertanda UTM untuk Facebook, Instagram, Google, TikTok, atau WhatsApp." },
  { title: "Tim dengan peran", text: "Owner, admin, advertiser, dan CS hanya melihat menu tugasnya." },
  { title: "Draf konten AI", text: "Draf deskripsi produk dengan AI; Anda yang menerbitkan." },
  { title: "Template CRM", text: "Pesan WhatsApp dengan nama, produk, dan data pesanan terisi." },
  { title: "API dan CLI", text: "REST API untuk frontend sendiri, Operations API dan CLI untuk skrip." },
];

/** FAQ grouped by the question a seller brings (/faq), drawn from the two lists above. */
export const FAQ_GROUPS: Array<{ title: string; items: Faq[] }> = [
  { title: "Biaya, komisi, dan langganan", items: [FAQ_SHORT[2], FAQ_SHORT[3], FAQ_MORE[2], FAQ_MORE[3], FAQ_MORE[9]] },
  { title: "Hybrid Form, iklan, dan sinyal 1:1", items: [FAQ_SHORT[0], FAQ_SHORT[1], FAQ_MORE[0], FAQ_MORE[7], FAQ_MORE[8]] },
  { title: "Dana, data, dan domain", items: [FAQ_SHORT[4], FAQ_MORE[4], FAQ_MORE[10]] },
  { title: "Memulai", items: [FAQ_MORE[1], FAQ_MORE[5], FAQ_MORE[6]] },
];
