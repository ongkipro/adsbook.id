// The adsbook.id marketing site's visuals (PLATFORM-SEO-AND-VISUAL-BANNERS-SPEC §4):
// seven 1200×630 share cards (public/og/*.png, each ≤ 120 KB) and the
// in-page 2.5D banners (public/visual/*.webp, drawn at 2× DPR).
//
//   npm run platform-visuals            # writes every file, prints sizes
//   npm run platform-visuals -- --sheet /tmp/seo-og-sheet.png   # also a contact sheet
//
// Deterministic: hand-built isometric SVG (no randomness, no network), the
// site's own display face from public/platform/fonts, rendered by the
// Playwright Chromium the browser suite already installs and compressed by
// sharp (Astro's own image dependency, as generate-card-derivatives.mjs).
// Borderless White Gallery: white and porcelain (#F4F6FA) studio light,
// #0F172A ink, one cobalt (#2563EB), no outlines, no wireframes.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const root = process.cwd();
const OG_DIR = join(root, "public/og");
const VISUAL_DIR = join(root, "public/visual");
const OG_MAX_BYTES = 120 * 1024;
const font = readFileSync(join(root, "public/platform/fonts/plus-jakarta-sans-800.woff2")).toString("base64");
const wordmark = readFileSync(join(root, "public/platform/brand/adsbook-id-wordmark.svg"), "utf8").replace(/<title>.*?<\/title>/, "");

const INK = "#0F172A";
const MUTED = "#475569";
const COBALT = "#2563EB";
const COBALT_DEEP = "#1D4ED8";
const COBALT_SHADE = "#1E40AF";
const ICE = "#DBEAFE";
const PORCELAIN = "#F4F6FA";

// ---- isometric drawing ----------------------------------------------------
const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;
/** A world → screen projection around origin (ox, oy) at `s` px per unit. */
function iso(ox, oy, s) {
  const P = (x, y, z = 0) => [ox + (x - y) * C30 * s, oy + (x + y) * S30 * s - z * s];
  const pts = (list) => list.map(([x, y, z]) => P(x, y, z).map((n) => n.toFixed(1)).join(",")).join(" ");
  /** A slab: top, right (+x) and left (+y) faces; tones go darker toward the viewer's shadow side. */
  const box = (x, y, z, w, d, h, { top = "#FFFFFF", right = "#E7ECF4", left = "#D9E0EB" } = {}) => `
    <polygon points="${pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${left}"/>
    <polygon points="${pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])}" fill="${right}"/>
    <polygon points="${pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${top}"/>`;
  const cube = (x, y, z, size) => box(x, y, z, size, size, size, { top: "#3B82F6", right: COBALT_DEEP, left: COBALT_SHADE });
  /** Content lying on a top face at height z, in local units (u along +x, v along +y). */
  const onTop = (x, y, z, inner) => {
    const [tx, ty] = P(x, y, z);
    return `<g transform="matrix(${(C30 * s).toFixed(4)},${(S30 * s).toFixed(4)},${(-C30 * s).toFixed(4)},${(S30 * s).toFixed(4)},${tx.toFixed(1)},${ty.toFixed(1)})">${inner}</g>`;
  };
  /** A soft contact shadow under a footprint. */
  const shadow = (x, y, w, d, opacity = 0.14) => `<polygon points="${pts([[x, y, 0], [x + w, y, 0], [x + w, y + d, 0], [x, y + d, 0]])}" fill="${INK}" opacity="${opacity}" filter="url(#soft)"/>`;
  return { P, pts, box, cube, onTop, shadow };
}

const label = (u, v, text, size, color = INK, weight = 800) =>
  `<text x="${u}" y="${v}" font-family="${weight >= 700 ? "Jakarta" : "Noto Sans"}" font-weight="${weight}" font-size="${size}" fill="${color}">${text}</text>`;
/** A flat (screen-aligned) floating chip, for platform names and statuses; `k` scales it inside a scene. */
const chip = (x, y, text, { dot = COBALT, w = null, k = 1 } = {}) => {
  const width = w ?? Math.round(text.length * 8.6 + 44);
  return `<g transform="translate(${x},${y}) scale(${k})">
    <rect x="0" y="0" width="${width}" height="38" rx="19" fill="#FFFFFF" filter="url(#float)"/>
    <rect x="16" y="15" width="8" height="8" fill="${dot}"/>
    <text x="32" y="24.5" font-family="Jakarta" font-weight="800" font-size="14" fill="${INK}">${text}</text></g>`;
};
const defs = `<defs>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="float" x="-20%" y="-40%" width="140%" height="200%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="${INK}" flood-opacity="0.10"/></filter>
  <radialGradient id="wash" cx="70%" cy="40%" r="75%"><stop offset="0" stop-color="${ICE}" stop-opacity="0.75"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
</defs>`;

// ---- scenes ----------------------------------------------------------------
// Each scene draws around the origin at any scale; `fit` places it in a box
// (the page script measures it with getBBox and centres it), so no scene can
// overflow its card whatever its labels measure.
const fit = (x, y, w, h, inner) => `<g data-fit="${x},${y},${w},${h}">${inner}</g>`;
const S = 40;
const BLUE = { top: "#3B82F6", right: COBALT_DEEP, left: COBALT_SHADE };

/** The signal lock: the cobalt cube on its porcelain plinth, three platforms above it. */
function sceneSignal() {
  const g = iso(0, 0, S);
  return `${g.shadow(-1.4, -1.4, 6.8, 6.8, 0.1)}
    ${g.box(-1.5, -1.5, 0, 7, 7, 0.5, { top: PORCELAIN })}
    ${g.box(-0.2, -0.2, 0.5, 4.4, 4.4, 0.35)}
    ${g.cube(0.7, 0.7, 0.85, 2.4)}
    ${g.onTop(-1.3, 4.3, 0.5, label(0, 0.95, "1 pesanan = 1 konversi", 0.62, MUTED))}
    ${chip(-330, -395, "Meta Ads", { k: 1.9 })}${chip(-95, -455, "Google Ads", { k: 1.9 })}${chip(150, -395, "TikTok Ads", { k: 1.9 })}`;
}
/**
 * Rows of slabs stepping toward the viewer along +y, the tallest at the back,
 * text running along +x on each top: nothing in front can cover a label.
 */
function rows(items, { width = 7.6, depth = 2.5, gap = 0.45, heights }) {
  const g = iso(0, 0, S);
  const total = items.length * (depth + gap) - gap;
  let out = g.shadow(0, 0, width, total, 0.1);
  items.forEach(({ title, sub, accent }, i) => {
    const y = i * (depth + gap);
    const h = heights[i];
    out += g.box(0, y, 0, width, depth, h, accent ? BLUE : {});
    out += g.onTop(0, y, h, `<rect x="0.5" y="0.55" width="0.5" height="0.5" fill="${accent ? "#FFFFFF" : COBALT}"/>${label(1.3, 1.02, title, 0.6, accent ? "#FFFFFF" : INK)}${label(1.3, 1.78, sub, 0.42, accent ? ICE : MUTED)}`);
  });
  return { out, g, total };
}
/** Product modes rising to the signal layer, which carries the cube. */
function sceneSteps() {
  const { out, g } = rows([
    { title: "Sinyal 1:1 dari server", sub: "Meta · Google · TikTok", accent: true },
    { title: "Produk Digital", sub: "Akses otomatis saat lunas" },
    { title: "Produk Fisik COD", sub: "Hybrid Form 38 provinsi" },
  ], { width: 9, heights: [2.3, 1.45, 0.6] });
  // The cube stands behind the signal layer, never on its label.
  return `${g.cube(6.9, -1.7, 0, 1.4)}${out}`;
}
/** Five gates on one path; the order passes them to the ad manager. */
function sceneGates(names = ["Klik", "Form", "Pesanan", "Kirim", "Konversi"], size = 0.46) {
  const g = iso(0, 0, S);
  const step = Math.max(2.75, Math.max(...names.map((name) => name.length)) * size * 0.6 + 1.2);
  const length = step * names.length + 0.6;
  let out = `${g.shadow(0, 0.6, length, 2.2, 0.1)}${g.box(0, 0.6, 0, length, 2.2, 0.28, { top: PORCELAIN })}`;
  names.forEach((name, i) => {
    const x = 0.6 + i * step;
    const tone = i === names.length - 1 ? BLUE : {};
    out += g.box(x, 0.25, 0.28, 0.36, 0.36, 2.2, tone);
    out += g.box(x, 2.8, 0.28, 0.36, 0.36, 2.2, tone);
    out += g.box(x, 0.25, 2.48, 0.36, 2.91, 0.26, i === names.length - 1 ? BLUE : { top: "#FFFFFF" });
    out += g.onTop(x - 0.3, 3.5, 0.28, label(0, 0.6, `${i + 1}`, Math.max(0.6, size), i === names.length - 1 ? COBALT : INK) + label(0.75, 0.6, name, size, MUTED));
  });
  out += g.cube(0.6 + step * 0.45, 1.3, 0.28, 0.85);
  out += g.cube(0.6 + step * 2.45, 1.3, 0.28, 0.85);
  return out;
}
/** Two lanes from one desk (behind them): seller help and buyer data protection. */
function sceneLanes() {
  const g = iso(0, 0, S);
  const desk = `${g.box(1.0, -3.4, 0, 3.2, 2.4, 1.6)}${g.cube(2.0, -2.9, 1.6, 1.1)}`;
  const { out } = rows([
    { title: "Tim dukungan seller", sub: "Akun, toko, langganan", accent: false },
    { title: "Perlindungan data pembeli", sub: "Diteruskan ke toko dalam 3 hari kerja" },
  ], { width: 10.4, heights: [0.5, 0.35] });
  return `${g.shadow(1.0, -3.4, 3.2, 2.4, 0.1)}${desk}${out}`;
}
/** Three plinths: preview without a deadline, two free months, 48-hour grace. */
function sceneShields() {
  return rows([
    { title: "Mode Preview tanpa batas waktu", sub: "Siapkan toko gratis sebelum membayar" },
    { title: "Hemat 2 bulan", sub: "Paket tahunan: bayar 10 bulan", accent: true },
    { title: "Masa tenggang 48 jam", sub: "Setelah jatuh tempo langganan" },
  ], { width: 11.6, heights: [1.7, 1.15, 0.6] }).out;
}
/** Two documents on porcelain (legal pages). */
function sceneDocs() {
  const g = iso(0, 0, S);
  const doc = (x, y, title) => `${g.box(x, y, 0, 3.8, 5.0, 0.16)}${g.onTop(x, y, 0.16, `${label(0.45, 0.95, title, 0.48)}${[1.6, 2.15, 2.7, 3.25, 3.8].map((v, i) => `<rect x="0.45" y="${v}" width="${i % 2 ? 2.2 : 2.9}" height="0.2" rx="0.1" fill="#E2E8F0"/>`).join("")}`)}`;
  return `${g.shadow(0, 0, 8.2, 5.6, 0.1)}${doc(0, 0, "Syarat Layanan")}${doc(4.3, 0.5, "Kebijakan Privasi")}${g.cube(3.0, 4.1, 0.16, 0.75)}`;
}
/** Three answer tiles: tracking, hybrid COD/digital, own domain. */
function sceneTiles() {
  return rows([
    { title: "Tracking 1:1", sub: "Meta, Google, TikTok", accent: true },
    { title: "COD + produk digital", sub: "Hybrid Form per provinsi" },
    { title: "Domain sendiri", sub: "SSL otomatis" },
  ], { width: 8.2, heights: [1.3, 0.85, 0.4] }).out;
}

// ---- share cards (1200×630) ------------------------------------------------
const ogFrame = (headline, sub, scene) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${defs}
  <rect width="1200" height="630" fill="#FFFFFF"/><rect width="1200" height="630" fill="url(#wash)"/>
  <g transform="translate(72,70) scale(0.7)">${wordmark.replace("<svg", '<svg width="228" height="36"')}</g>
  <foreignObject x="72" y="150" width="520" height="420"><div xmlns="http://www.w3.org/1999/xhtml" style="height:420px;display:flex;flex-direction:column;justify-content:center;gap:22px">
    <div style="font-family:Jakarta;font-weight:800;font-size:56px;line-height:1.07;letter-spacing:-0.02em;color:${INK}">${headline}<span style="display:inline-block;width:0.16em;height:0.16em;margin-left:0.06em;background:${COBALT}"></span></div>
    <div style="font-family:'Noto Sans';font-weight:600;font-size:24px;line-height:1.4;color:${MUTED}">${sub}</div></div></foreignObject>
  ${fit(640, 70, 500, 490, scene)}
</svg>`;

const OG = {
  "og-home": ogFrame("Satu pesanan, satu konversi", "Toko COD dan produk digital untuk pengiklan di semua platform.", sceneSignal()),
  "og-fitur": ogFrame("Fitur yang membuat setiap pesanan presisi", "Produk fisik COD, produk digital, dan sinyal 1:1 ke tiga platform iklan.", sceneSteps()),
  "og-cara-kerja": ogFrame("Dari ad click sampai konversi tercatat", "Lima langkah yang sama untuk setiap pesanan, dari platform iklan mana pun.", sceneGates()),
  "og-harga": ogFrame("Rp149.000 per bulan, per toko", "0% potongan transaksi. Paket tahunan: bayar 10 bulan, gratis 2 bulan.", sceneShields()),
  "og-faq": ogFrame("Pusat jawaban pengiklan", "Tracking, COD dan digital, domain sendiri: dijawab singkat.", sceneTiles()),
  "og-kontak": ogFrame("Dukungan seller, privasi pembeli", "Satu kontak untuk akun dan toko; data pembeli diteruskan ke tokonya.", sceneLanes()),
  "og-legal": ogFrame("Syarat layanan dan kebijakan privasi", "Dokumen resmi adsbook.id untuk seller dan pengunjung.", sceneDocs()),
};

// ---- in-page banners (CSS px; drawn at 2×) ---------------------------------
const bannerFrame = (width, height, scene, pad = 36) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}
  <rect width="${width}" height="${height}" fill="${PORCELAIN}"/>${fit(pad, pad, width - pad * 2, height - pad * 2, scene)}</svg>`;

export const BANNERS = {
  fitur: { width: 640, height: 440, svg: bannerFrame(640, 440, `${sceneSteps()}${chip(150, -300, "Meta Ads", { k: 1.8 })}${chip(150, -215, "Google Ads", { k: 1.8 })}${chip(150, -130, "TikTok Ads", { k: 1.8 })}`, 28) },
  "cara-kerja": { width: 640, height: 440, svg: bannerFrame(640, 440, sceneGates(["Ad click", "Form COD / QRIS", "Pesanan masuk", "Kirim / akses", "Ads Manager"], 0.62), 20) },
  harga: { width: 640, height: 440, svg: bannerFrame(640, 440, sceneShields(), 28) },
  faq: { width: 640, height: 420, svg: bannerFrame(640, 420, sceneTiles(), 28) },
  kontak: { width: 640, height: 440, svg: bannerFrame(640, 440, sceneLanes(), 28) },
  "home-closing": { width: 640, height: 460, svg: bannerFrame(640, 460, sceneSignal(), 28) },
};

const page = (svg, width, height) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Jakarta; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 800; }
  html, body { margin: 0; background: #fff; } svg { display: block; }
</style></head><body style="width:${width}px;height:${height}px">${svg}<script>
  document.fonts.ready.then(() => {
    for (const group of document.querySelectorAll("g[data-fit]")) {
      const [x, y, w, h] = group.dataset.fit.split(",").map(Number);
      const box = group.getBBox();
      const scale = Math.min(w / box.width, h / box.height);
      group.setAttribute("transform", \`translate(\${x + (w - box.width * scale) / 2 - box.x * scale},\${y + (h - box.height * scale) / 2 - box.y * scale}) scale(\${scale})\`);
    }
    document.body.dataset.ready = "1";
  });
</script></body></html>`;

async function main() {
  const sheetIndex = process.argv.indexOf("--sheet");
  const sheetPath = sheetIndex > -1 ? process.argv[sheetIndex + 1] : null;
  mkdirSync(OG_DIR, { recursive: true });
  mkdirSync(VISUAL_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const tab = await context.newPage();
  const render = async (svg, width, height) => {
    await tab.setViewportSize({ width, height });
    await tab.setContent(page(svg, width, height), { waitUntil: "load" });
    await tab.waitForSelector("body[data-ready]");
    return tab.screenshot({ clip: { x: 0, y: 0, width, height } });
  };
  const report = [];
  const ogFiles = [];
  for (const [name, svg] of Object.entries(OG)) {
    const shot = await render(svg, 1200, 630);
    // Rendered at 2×, downsampled: crisp edges, then a palette PNG every share preview reads.
    let quality = 92;
    let png;
    do {
      png = await sharp(shot).resize(1200, 630, { kernel: "lanczos3" }).png({ palette: true, quality, effort: 10, compressionLevel: 9 }).toBuffer();
      quality -= 8;
    } while (png.length > OG_MAX_BYTES && quality > 40);
    if (png.length > OG_MAX_BYTES) throw new Error(`${name}.png is ${png.length} bytes (> ${OG_MAX_BYTES})`);
    const file = join(OG_DIR, `${name}.png`);
    writeFileSync(file, png);
    ogFiles.push(file);
    report.push(`${name}.png  1200×630  ${(png.length / 1024).toFixed(1)} KB`);
  }
  for (const [name, banner] of Object.entries(BANNERS)) {
    const shot = await render(banner.svg, banner.width, banner.height);
    const webp = await sharp(shot).webp({ quality: 84, effort: 6 }).toBuffer();
    writeFileSync(join(VISUAL_DIR, `${name}.webp`), webp);
    report.push(`${name}.webp  ${banner.width * 2}×${banner.height * 2}  ${(webp.length / 1024).toFixed(1)} KB`);
  }
  if (sheetPath) {
    const tiles = await Promise.all(ogFiles.map((file) => sharp(file).resize(600, 315).toBuffer()));
    const sheet = sharp({ create: { width: 1240, height: 20 + Math.ceil(tiles.length / 2) * 335, channels: 3, background: "#e2e8f0" } });
    await sheet.composite(tiles.map((input, i) => ({ input, left: 20 + (i % 2) * 610, top: 20 + Math.floor(i / 2) * 335 }))).png().toFile(sheetPath);
    report.push(`sheet → ${sheetPath}`);
  }
  await browser.close();
  console.log(report.join("\n"));
  for (const file of ogFiles) if (statSync(file).size > OG_MAX_BYTES) process.exitCode = 1;
}

await main();
