/**
 * The home hero's 2.5D stage (Paduka, 2026-11-18: adsbook_id_precision_100vh_3d_hero.html):
 * the sculptural "a." on a porcelain dial, three ad channels feeding one
 * splitter, browser and server photons converging on the square blue cube,
 * a 90° lock, and the "1:1 #XX-n" telemetry. Bundled by Vite into one hashed
 * chunk that only the home page loads (KineticHero3D.astro); no CDN.
 *
 * Ported from the reference's three r128 to the installed three: colour
 * management off and linear output plus π-scaled light intensities reproduce
 * r128's look. Motion respects `prefers-reduced-motion` (one still frame, no
 * loop) and the loop stops whenever the hero is off screen or the tab hidden.
 */
import * as THREE from "three";

const CHANNELS = [
  { code: "TT", token: "token-tiktok", ind: "ind-tiktok" },
  { code: "MT", token: "token-meta", ind: "ind-meta" },
  { code: "GG", token: "token-google", ind: "ind-google" },
] as const;

/** The still frame shows the lock: cube indexed, reticle closed, ripple on its way out. */
const STILL_T = 1.95;
const CYCLE_DURATION = 3.6;
const FOV_DEG = 24;

function chamferedSquareCube(size: number, chamfer: number) {
  const inner = size - chamfer * 2;
  const h = inner * 0.5;
  const square = new THREE.Shape();
  square.moveTo(-h, -h);
  square.lineTo(h, -h);
  square.lineTo(h, h);
  square.lineTo(-h, h);
  square.closePath();
  const geo = new THREE.ExtrudeGeometry(square, {
    depth: inner, bevelEnabled: true, bevelThickness: chamfer, bevelSize: chamfer, bevelSegments: 1, curveSegments: 1,
  });
  geo.translate(0, 0, -inner * 0.5);
  geo.computeVertexNormals();
  return geo;
}

function extrudedRingDisc(outerR: number, innerR: number, depth: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  if (innerR > 0.001) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 56,
  });
  geo.translate(0, 0, -depth * 0.5);
  geo.rotateX(-Math.PI * 0.5);
  geo.computeVertexNormals();
  return geo;
}

type Point = { x: number; y: number };

/** The brand's "a" from the self-hosted display face, traced (marching squares) and extruded; a drawn "a" if that fails. */
function sculpturalA(targetHeight: number, extrudeDepth: number) {
  try {
    const size = 280;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = '800 212px "Plus Jakarta Sans", sans-serif';
    ctx.fillText("a", size * 0.5, size * 0.78);

    const img = ctx.getImageData(0, 0, size, size).data;
    const field = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const sy = size - 1 - y;
      for (let x = 0; x < size; x++) field[y * size + x] = img[(sy * size + x) * 4];
    }

    const iso = 127.5;
    const verts: Point[] = [];
    const hEdges = new Int32Array(size * size).fill(-1);
    const vEdges = new Int32Array(size * size).fill(-1);
    const getH = (x: number, y: number) => {
      const idx = y * size + x;
      if (hEdges[idx] !== -1) return hEdges[idx];
      const v0 = field[idx], v1 = field[idx + 1];
      const t = Math.abs(v1 - v0) < 1e-5 ? 0.5 : Math.max(0, Math.min(1, (iso - v0) / (v1 - v0)));
      hEdges[idx] = verts.push({ x: x + t, y }) - 1;
      return hEdges[idx];
    };
    const getV = (x: number, y: number) => {
      const idx = y * size + x;
      if (vEdges[idx] !== -1) return vEdges[idx];
      const v0 = field[idx], v1 = field[idx + size];
      const t = Math.abs(v1 - v0) < 1e-5 ? 0.5 : Math.max(0, Math.min(1, (iso - v0) / (v1 - v0)));
      vEdges[idx] = verts.push({ x, y: y + t }) - 1;
      return vEdges[idx];
    };

    const next = new Map<number, number>();
    const seg = (u: number, v: number) => next.set(u, v);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const bl = field[y * size + x], br = field[y * size + x + 1];
        const tr = field[(y + 1) * size + x + 1], tl = field[(y + 1) * size + x];
        let m = 0;
        if (bl >= iso) m |= 1;
        if (br >= iso) m |= 2;
        if (tr >= iso) m |= 4;
        if (tl >= iso) m |= 8;
        if (m === 0 || m === 15) continue;
        const B = () => getH(x, y), R = () => getV(x + 1, y), T = () => getH(x, y + 1), L = () => getV(x, y);
        const centre = 0.25 * (bl + br + tr + tl) >= iso;
        switch (m) {
          case 1: seg(B(), L()); break;
          case 2: seg(R(), B()); break;
          case 3: seg(R(), L()); break;
          case 4: seg(T(), R()); break;
          case 5: if (centre) { seg(B(), R()); seg(T(), L()); } else { seg(B(), L()); seg(T(), R()); } break;
          case 6: seg(T(), B()); break;
          case 7: seg(T(), L()); break;
          case 8: seg(L(), T()); break;
          case 9: seg(B(), T()); break;
          case 10: if (centre) { seg(L(), B()); seg(R(), T()); } else { seg(R(), B()); seg(L(), T()); } break;
          case 11: seg(R(), T()); break;
          case 12: seg(L(), R()); break;
          case 13: seg(B(), R()); break;
          case 14: seg(L(), B()); break;
        }
      }
    }

    const seen = new Set<number>();
    const loops: { pts: Point[]; area: number }[] = [];
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const pts: Point[] = [];
      let c: number | undefined = start;
      let guard = 0;
      while (c !== undefined && !seen.has(c) && guard < 9000) {
        seen.add(c);
        pts.push(verts[c]);
        c = next.get(c);
        guard++;
      }
      if (pts.length > 16) {
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
          area += (p0.x * p1.y - p1.x * p0.y) * 0.5;
        }
        if (Math.abs(area) > 60) loops.push({ pts, area });
      }
    }
    if (!loops.length) throw new Error("no contour");
    loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

    const resample = (raw: Point[], count: number) => {
      const n = raw.length;
      const cum = [0];
      for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(raw[(i + 1) % n].x - raw[i].x, raw[(i + 1) % n].y - raw[i].y));
      const total = cum[n];
      let res: Point[] = [];
      let idx = 0;
      for (let k = 0; k < count; k++) {
        const d = (k / count) * total;
        while (idx < n - 1 && cum[idx + 1] < d) idx++;
        const l = cum[idx + 1] - cum[idx];
        const t = l < 1e-6 ? 0 : (d - cum[idx]) / l;
        const a = raw[idx], b = raw[(idx + 1) % n];
        res.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      for (let pass = 0; pass < 2; pass++) {
        res = res.map((curr, i) => {
          const prev = res[(i - 1 + count) % count], nxt = res[(i + 1) % count];
          const v1x = curr.x - prev.x, v1y = curr.y - prev.y, v2x = nxt.x - curr.x, v2y = nxt.y - curr.y;
          const cos = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) || 1) * (Math.hypot(v2x, v2y) || 1));
          return cos < 0.85 ? curr : { x: 0.24 * prev.x + 0.52 * curr.x + 0.24 * nxt.x, y: 0.24 * prev.y + 0.52 * curr.y + 0.24 * nxt.y };
        });
      }
      return res;
    };

    const outer = resample(loops[0].pts, 160);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let stemY = Infinity;
    const rz = minX + 0.68 * (maxX - minX), bz = minY + 0.25 * (maxY - minY);
    for (const p of outer) if (p.x >= rz && p.y <= bz && p.y < stemY) stemY = p.y;
    if (!Number.isFinite(stemY)) stemY = minY;

    const sc = targetHeight / (maxY - stemY);
    const toV = (p: Point) => new THREE.Vector2((p.x - maxX) * sc, (p.y - stemY) * sc);
    const shape = new THREE.Shape(outer.map(toV));
    for (let h = 1; h < loops.length; h++) shape.holes.push(new THREE.Path(resample(loops[h].pts, 68).map(toV)));
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: extrudeDepth, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.015, bevelSegments: 3, curveSegments: 1,
    });
    geo.translate(0, 0, -extrudeDepth * 0.5);
    geo.computeVertexNormals();
    return geo;
  } catch {
    const h = targetHeight, w = h * 0.84;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-w * 0.3, 0);
    shape.lineTo(-w * 0.3, h * 0.12);
    shape.bezierCurveTo(-w * 0.42, -h * 0.03, -w * 0.98, -h * 0.03, -w * 0.98, h * 0.29);
    shape.bezierCurveTo(-w * 0.98, h * 0.57, -w * 0.62, h * 0.62, -w * 0.31, h * 0.62);
    shape.lineTo(-w * 0.31, h * 0.67);
    shape.bezierCurveTo(-w * 0.31, h * 0.79, -w * 0.43, h * 0.82, -w * 0.56, h * 0.82);
    shape.bezierCurveTo(-w * 0.7, h * 0.82, -w * 0.78, h * 0.76, -w * 0.82, h * 0.69);
    shape.lineTo(-w * 0.96, h * 0.82);
    shape.bezierCurveTo(-w * 0.86, h * 0.96, -w * 0.68, h * 1.02, -w * 0.48, h * 1.02);
    shape.bezierCurveTo(-w * 0.15, h * 1.02, 0, h * 0.86, 0, h * 0.58);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-w * 0.31, h * 0.44);
    hole.bezierCurveTo(-w * 0.54, h * 0.44, -w * 0.68, h * 0.39, -w * 0.68, h * 0.28);
    hole.bezierCurveTo(-w * 0.68, h * 0.18, -w * 0.56, h * 0.15, -w * 0.46, h * 0.15);
    hole.bezierCurveTo(-w * 0.36, h * 0.15, -w * 0.31, h * 0.22, -w * 0.31, h * 0.32);
    hole.closePath();
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: extrudeDepth, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.015, bevelSegments: 3, curveSegments: 20,
    });
    geo.translate(0, 0, -extrudeDepth * 0.5);
    geo.computeVertexNormals();
    return geo;
  }
}

/** A light ribbon: a travelling head with a tail over a faint track. */
function filament(coreHex: number, glowHex: number, idleOpacity: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uProgress: { value: -0.45 },
      uTail: { value: 0.38 },
      uBaseAlpha: { value: idleOpacity },
      uBoost: { value: 1.0 },
      uCore: { value: new THREE.Color(coreHex) },
      uGlow: { value: new THREE.Color(glowHex) },
      uTrack: { value: new THREE.Color(0xbfdbfe) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uProgress; uniform float uTail; uniform float uBaseAlpha; uniform float uBoost;
      uniform vec3 uCore; uniform vec3 uGlow; uniform vec3 uTrack;
      varying vec2 vUv;
      void main() {
        float t = vUv.x;
        float d = uProgress - t;
        float tail = (d >= 0.0 && d <= uTail) ? pow(1.0 - d / uTail, 1.6) : 0.0;
        float head = exp(-pow((t - uProgress) * 28.0, 2.0));
        float pulse = clamp(tail + head * 0.9, 0.0, 1.0) * uBoost;
        vec3 col = mix(uTrack, uGlow, pulse * 0.8);
        col = mix(col, uCore, pow(pulse, 1.35));
        gl_FragColor = vec4(col, clamp(uBaseAlpha + pulse * 0.92, 0.0, 0.98));
      }
    `,
  });
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x: number) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);

/** Wire the hero inside `root` (#hero-root). Returns false when WebGL is unavailable (the hero stays a still page). */
export function startKineticStage(root: HTMLElement): boolean {
  const canvas = root.querySelector<HTMLCanvasElement>("#stage-canvas");
  const slot = root.querySelector<HTMLElement>("#stage-slot");
  if (!canvas || !slot) return false;
  const byId = (id: string) => root.querySelector<HTMLElement>(`#${id}`);
  const tokens = CHANNELS.map((channel) => byId(channel.token));
  const inds = CHANNELS.map((channel) => byId(channel.ind));
  const tagBrowser = byId("tag-browser");
  const tagServer = byId("tag-server");
  const pill = byId("telemetry-pill");
  const pillDot = byId("telemetry-dot");
  const pillStatus = byId("telemetry-status");

  let renderer: THREE.WebGLRenderer;
  try {
    THREE.ColorManagement.enabled = false;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return false;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 120);
  // Physical light units since three r155: ×π keeps r128's (legacy) brightness.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdbeafe, 1.12 * Math.PI));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.95 * Math.PI);
  keyLight.position.set(-4.0, 8.5, 9.0);
  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.72 * Math.PI);
  fillLight.position.set(5.5, 4.0, 6.0);
  const rimLight = new THREE.DirectionalLight(0x2563eb, 0.85 * Math.PI);
  rimLight.position.set(0.0, 5.0, -5.5);
  scene.add(keyLight, fillLight, rimLight);

  const stageRoot = new THREE.Group();
  scene.add(stageRoot);

  // Porcelain dial, vernier ring, shockwave.
  const dial = new THREE.Group();
  dial.rotation.x = 0.48;
  dial.position.set(0, -0.26, 0);
  stageRoot.add(dial);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 4.4),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0x1e40af) }, uOpacity: { value: 0.11 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
        void main() { float d = length((vUv - 0.5) * 2.0); gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.32, 1.0, d)) * uOpacity); }`,
    }),
  );
  shadow.rotation.x = -Math.PI * 0.5;
  shadow.position.y = -0.13;
  dial.add(shadow);

  const porcelain = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.01, clearcoat: 0.7, clearcoatRoughness: 0.16 });
  const porcelainRim = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, emissive: new THREE.Color(0x3b82f6), emissiveIntensity: 0.06, roughness: 0.35 });
  const outerDisc = new THREE.Mesh(extrudedRingDisc(1.78, 1.18, 0.06), [porcelain, porcelainRim]);
  outerDisc.position.y = -0.05;
  dial.add(outerDisc, new THREE.Mesh(extrudedRingDisc(1.06, 0.0, 0.08), [porcelain, porcelainRim]));

  const vernier = new THREE.Group();
  vernier.position.y = 0.025;
  dial.add(vernier);
  const ticks: number[] = [];
  for (let i = 0; i < 72; i++) {
    const ang = (i / 72) * Math.PI * 2;
    const r0 = i % 6 === 0 ? 1.24 : 1.28;
    ticks.push(Math.sin(ang) * r0, 0, -Math.cos(ang) * r0, Math.sin(ang) * 1.35, 0, -Math.cos(ang) * 1.35);
  }
  const tickGeo = new THREE.BufferGeometry();
  tickGeo.setAttribute("position", new THREE.Float32BufferAttribute(ticks, 3));
  vernier.add(new THREE.LineSegments(tickGeo, new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.68 })));
  const indexSquare = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.08), new THREE.MeshBasicMaterial({ color: 0x2563eb }));
  indexSquare.position.set(0, 0.01, -1.42);
  vernier.add(indexSquare);

  const waveGeo = new THREE.RingGeometry(0.32, 0.37, 72);
  waveGeo.rotateX(-Math.PI * 0.5);
  const waveMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
  const wave = new THREE.Mesh(waveGeo, waveMat);
  wave.position.y = 0.055;
  dial.add(wave);

  // The "a." monolith and the square cube.
  const monolith = new THREE.Group();
  monolith.position.set(0, 0.04, 0.08);
  stageRoot.add(monolith);
  const letterSide = new THREE.MeshStandardMaterial({ color: 0xbfdbfe, emissive: new THREE.Color(0x2563eb), emissiveIntensity: 0.16, roughness: 0.25 });
  const letterA = new THREE.Mesh(sculpturalA(1.12, 0.22), [
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.32, metalness: 0.08 }),
    letterSide,
  ]);
  letterA.position.set(-0.04, -0.46, 0);
  monolith.add(letterA);

  const CUBE_SIZE = 0.36;
  const CUBE_BASE = new THREE.Vector3(0.35, -0.28, 0.05);
  const cubePivot = new THREE.Group();
  cubePivot.position.copy(CUBE_BASE);
  monolith.add(cubePivot);
  cubePivot.add(new THREE.Mesh(
    chamferedSquareCube(CUBE_SIZE * 0.76, 0.014),
    new THREE.MeshStandardMaterial({ color: 0x1d4ed8, emissive: new THREE.Color(0x2563eb), emissiveIntensity: 0.55, roughness: 0.18 }),
  ));
  const shellGeo = chamferedSquareCube(CUBE_SIZE, 0.02);
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0x2563eb, emissive: new THREE.Color(0x3b82f6), emissiveIntensity: 0.24, roughness: 0.1, metalness: 0.1, clearcoat: 1.0, transparent: true, opacity: 0.94,
  });
  const shell = new THREE.Mesh(shellGeo, shellMat);
  cubePivot.add(shell, new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo, 22), new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.9 })));

  const reticle = new THREE.Group();
  reticle.position.set(CUBE_BASE.x, CUBE_BASE.y, CUBE_BASE.z + CUBE_SIZE * 0.62);
  monolith.add(reticle);
  const reticleMat = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.0 });
  const rLen = 0.105, rThk = 0.018;
  const brackets = [{ sx: 1, sy: 1 }, { sx: -1, sy: 1 }, { sx: -1, sy: -1 }, { sx: 1, sy: -1 }].map(({ sx, sy }) => {
    const g = new THREE.Group();
    const h = new THREE.Mesh(new THREE.BoxGeometry(rLen, rThk, 0.016), reticleMat);
    h.position.set(-sx * (rLen * 0.5 - rThk * 0.5), 0, 0);
    const v = new THREE.Mesh(new THREE.BoxGeometry(rThk, rLen, 0.016), reticleMat);
    v.position.set(0, -sy * (rLen * 0.5 - rThk * 0.5), 0);
    g.add(h, v);
    reticle.add(g);
    return { g, sx, sy };
  });

  // Ribbons and photons.
  const feeders = [filament(0x2563eb, 0x60a5fa, 0.16), filament(0x2563eb, 0x60a5fa, 0.16), filament(0x2563eb, 0x60a5fa, 0.16)];
  const browserRail = filament(0x3b82f6, 0x93c5fd, 0.26);
  const serverRail = filament(0x1d4ed8, 0x3b82f6, 0.26);
  const verticalOut = filament(0x2563eb, 0x60a5fa, 0.22);
  const photon = (hex: number) => {
    const g = new THREE.Group();
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.088, 0.088), new THREE.MeshBasicMaterial({ color: hex })),
      new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.145, 0.145), new THREE.MeshBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.38 })),
    );
    g.visible = false;
    stageRoot.add(g);
    return g;
  };
  const photonBrowser = photon(0x60a5fa);
  const photonServer = photon(0x2563eb);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x3b82f6 }));
  stageRoot.add(splitter);

  const tubes: THREE.Mesh[] = [];
  let spreadMode: "compact" | "wide" | null = null;
  const crown = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const splitterAt = new THREE.Vector3(0, 0.62, -1.28);
  const cubeAt = new THREE.Vector3(monolith.position.x + CUBE_BASE.x, monolith.position.y + CUBE_BASE.y, monolith.position.z + CUBE_BASE.z);
  const browserTagAt = new THREE.Vector3();
  const serverTagAt = new THREE.Vector3();
  let browserCurve: THREE.CatmullRomCurve3 | null = null;
  let serverCurve: THREE.CatmullRomCurve3 | null = null;

  function buildCurves(compact: boolean) {
    for (const tube of tubes.splice(0)) {
      tube.geometry.dispose();
      stageRoot.remove(tube);
    }
    spreadMode = compact ? "compact" : "wide";
    const xSpread = compact ? 1.44 : 1.88, ySide = compact ? 1.34 : 1.38, yMid = compact ? 1.56 : 1.62;
    crown[0].set(-xSpread, ySide, -0.35);
    crown[1].set(0.0, yMid, -0.48);
    crown[2].set(xSpread, ySide, -0.35);
    splitter.position.copy(splitterAt);
    const addTube = (curve: THREE.Curve<THREE.Vector3>, segments: number, radius: number, radial: number, material: THREE.Material) => {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, radial, false), material);
      stageRoot.add(tube);
      tubes.push(tube);
    };
    crown.forEach((s, i) => {
      const e = splitterAt;
      addTube(new THREE.CubicBezierCurve3(s, new THREE.Vector3(s.x * 0.72, s.y - 0.34, s.z - 0.25), new THREE.Vector3(e.x + s.x * 0.16, e.y + 0.28, e.z + 0.12), e), 36, 0.015, 8, feeders[i]);
    });
    const r = compact ? 1.58 : 1.72;
    browserCurve = new THREE.CatmullRomCurve3([
      splitterAt.clone(), new THREE.Vector3(-r * 0.78, 0.34, -0.72), new THREE.Vector3(-r, -0.06, 0.15), new THREE.Vector3(-r * 0.52, -0.34, 0.78), cubeAt.clone(),
    ]);
    addTube(browserCurve, 72, 0.021, 10, browserRail);
    browserTagAt.copy(browserCurve.getPointAt(0.46)).add(new THREE.Vector3(-0.28, 0.08, 0));
    serverCurve = new THREE.CatmullRomCurve3([
      splitterAt.clone(), new THREE.Vector3(r * 0.78, 0.34, -0.72), new THREE.Vector3(r, -0.02, 0.18), new THREE.Vector3(r * 0.62, -0.22, 0.66), cubeAt.clone(),
    ]);
    addTube(serverCurve, 72, 0.021, 10, serverRail);
    serverTagAt.copy(serverCurve.getPointAt(0.46)).add(new THREE.Vector3(0.28, 0.08, 0));
    addTube(new THREE.CubicBezierCurve3(cubeAt.clone(), new THREE.Vector3(cubeAt.x, cubeAt.y - 0.38, cubeAt.z + 0.08), new THREE.Vector3(0.0, -0.95, 0.18), new THREE.Vector3(0.0, -1.48, 0.22)), 40, 0.018, 8, verticalOut);
  }

  // The stage is centred and scaled inside #stage-slot; the canvas fills the hero.
  let fullW = root.clientWidth || window.innerWidth;
  let fullH = root.clientHeight || window.innerHeight;
  // The geometry last fitted: a resize that changes none of it (Safari's bars, a pinch, the
  // keyboard) leaves the canvas alone, because resizing it clears its buffer.
  let fitted = "";
  function fit(): boolean {
    fullW = root.clientWidth || window.innerWidth || 360;
    fullH = root.clientHeight || window.innerHeight || 640;
    const slotRect = slot!.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const geometry = [fullW, fullH, slotRect.width, slotRect.height, slotRect.left - rootRect.left, slotRect.top - rootRect.top, renderer.getPixelRatio()]
      .map((value) => Math.round(value * 10) / 10)
      .join(",");
    if (geometry === fitted) return false;
    fitted = geometry;
    const slotW = Math.max(slotRect.width, 220);
    const slotH = Math.max(slotRect.height, 180);
    const compact = slotW < 540;
    if (spreadMode !== (compact ? "compact" : "wide")) buildCurves(compact);
    const worldW = compact ? 4.35 : 5.35;
    const worldH = compact ? 3.55 : 3.72;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV_DEG * 0.5));
    const dist = Math.max((worldH * fullH) / (2 * slotH * tanHalf), (worldW * fullH) / (2 * slotW * tanHalf));
    camera.aspect = fullW / fullH;
    camera.position.set(0, 0.35, dist);
    camera.lookAt(0, 0.05, 0);
    const centreX = slotRect.left - rootRect.left + slotW * 0.5;
    const centreY = slotRect.top - rootRect.top + slotH * 0.5;
    camera.setViewOffset(fullW, fullH, fullW * 0.5 - centreX, fullH * 0.5 - centreY, fullW, fullH);
    camera.updateProjectionMatrix();
    renderer.setSize(fullW, fullH);
    return true;
  }

  // State: the active channel, the order sequence, a tapped channel waiting for the next frame.
  let activeIdx = 0;
  let requestedIdx: number | null = null;
  let orderSeq = 8421;
  let cycleOrigin = performance.now() * 0.001;
  let prevCycle = 0;
  let locked = false;
  let cubeTarget = 0;
  let cubeCurrent = 0;
  const VERNIER = [-0.46, 0.0, 0.46];
  let vernierY = VERNIER[0];
  let tiltX = 0, tiltY = 0;

  function activate(idx: number) {
    activeIdx = idx;
    tokens.forEach((el, i) => {
      el?.classList.toggle("is-active", i === idx);
      el?.setAttribute("aria-pressed", String(i === idx));
    });
    inds.forEach((el, i) => {
      if (!el) return;
      el.style.backgroundColor = i === idx ? "#2563EB" : "#CBD5E1";
      el.style.boxShadow = i === idx ? "0 0 8px rgba(37,99,235,0.7)" : "none";
    });
    if (pillStatus) pillStatus.textContent = `1:1 #${CHANNELS[idx].code}-${orderSeq}`;
  }

  const proj = new THREE.Vector3();
  function place(el: HTMLElement | null, local: THREE.Vector3, scale: number) {
    if (!el) return;
    proj.copy(local);
    stageRoot.localToWorld(proj);
    proj.project(camera);
    const x = (proj.x * 0.5 + 0.5) * fullW;
    const y = (-proj.y * 0.5 + 0.5) * fullH;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  }

  /** One frame. `still` freezes the choreography at the lock (reduced motion). */
  function step(now: number, still: boolean) {
    if (requestedIdx !== null) {
      const nextIdx = requestedIdx;
      requestedIdx = null;
      cycleOrigin = now;
      prevCycle = 0;
      locked = false;
      orderSeq++;
      activate(nextIdx);
    }
    const elapsed = still ? STILL_T : now - cycleOrigin;
    const cycle = Math.floor(elapsed / CYCLE_DURATION);
    if (!still && cycle !== prevCycle) {
      prevCycle = cycle;
      locked = false;
      orderSeq++;
      activate((activeIdx + 1) % 3);
    }
    const t = elapsed % CYCLE_DURATION;
    const ease = still ? 1 : 0.07;

    stageRoot.rotation.y += (tiltY - stageRoot.rotation.y) * ease;
    stageRoot.rotation.x += (tiltX - stageRoot.rotation.x) * ease;
    monolith.position.y = 0.04 + (still ? 0 : Math.sin(now * 1.7) * 0.032);
    vernierY += (VERNIER[activeIdx] - vernierY) * (still ? 1 : 0.085);
    vernier.rotation.y = vernierY;

    feeders.forEach((material, i) => {
      const u = material.uniforms;
      const on = i === activeIdx;
      u.uBaseAlpha.value = on ? 0.38 : 0.13;
      u.uBoost.value = on ? 1.0 : 0.0;
      u.uProgress.value = on && t >= 0.04 && t <= 0.72 ? clamp01((t - 0.04) / 0.48) * 1.32 : -0.45;
    });
    splitter.scale.setScalar(1.0 + Math.exp(-Math.pow((t - 0.5) * 8.0, 2.0)) * 0.45);
    splitter.rotation.y = now * 1.8;

    const dual = t >= 0.48 && t <= 1.62;
    if (dual && browserCurve && serverCurve) {
      const raw = clamp01((t - 0.48) / 1.04);
      const eased = easeInOutCubic(raw);
      browserRail.uniforms.uProgress.value = serverRail.uniforms.uProgress.value = eased * 1.28;
      browserRail.uniforms.uBaseAlpha.value = serverRail.uniforms.uBaseAlpha.value = 0.36;
      const flying = raw < 0.98;
      photonBrowser.visible = photonServer.visible = flying;
      if (flying) {
        photonBrowser.position.copy(browserCurve.getPointAt(eased));
        photonServer.position.copy(serverCurve.getPointAt(eased));
        photonBrowser.rotation.set(now * 4.5, now * 5.2, 0);
        photonServer.rotation.set(-now * 4.5, now * 5.2, 0);
      }
    } else {
      browserRail.uniforms.uProgress.value = serverRail.uniforms.uProgress.value = -0.45;
      browserRail.uniforms.uBaseAlpha.value = serverRail.uniforms.uBaseAlpha.value = 0.22;
      photonBrowser.visible = photonServer.visible = false;
    }

    if (t >= 1.5 && !locked) {
      locked = true;
      cubeTarget += Math.PI * 0.5;
    }
    cubeCurrent += (cubeTarget - cubeCurrent) * (still ? 1 : 0.16);
    cubePivot.rotation.y = cubeCurrent;
    const approach = t >= 0.65 && t < 1.5 ? Math.sin(clamp01((t - 0.65) / 0.85) * Math.PI) * 0.12 : 0;
    const pop = Math.exp(-Math.pow((t - 1.55) * 10.0, 2.0));
    cubePivot.position.z = CUBE_BASE.z + approach;
    cubePivot.scale.setScalar(1.0 + pop * 0.12);

    let glow = 0;
    if (t >= 1.48 && t < 1.78) glow = easeOutCubic(clamp01((t - 1.48) / 0.3));
    else if (t >= 1.78 && t < 2.55) glow = 1.0;
    else if (t >= 2.55 && t < 3.3) glow = 1.0 - easeOutCubic(clamp01((t - 2.55) / 0.75));
    shellMat.emissiveIntensity = 0.22 + glow * 0.68 + pop * 0.45;
    letterSide.emissiveIntensity = 0.14 + glow * 0.34;
    porcelainRim.emissiveIntensity = 0.05 + glow * 0.2;

    reticle.visible = t >= 1.44 && t <= 2.95;
    if (reticle.visible) {
      const snap = easeOutBack(clamp01((t - 1.44) / 0.3));
      const radius = CUBE_SIZE * 0.94 + (CUBE_SIZE * 0.63 - CUBE_SIZE * 0.94) * snap;
      for (const b of brackets) b.g.position.set(b.sx * radius, b.sy * radius, 0);
      reticleMat.opacity = clamp01((t - 1.44) / 0.12) * (1.0 - easeOutCubic(clamp01((t - 2.45) / 0.5))) * 0.95;
    }
    wave.visible = t >= 1.52 && t <= 2.85;
    if (wave.visible) {
      const wp = easeOutCubic(clamp01((t - 1.52) / 1.33));
      wave.scale.setScalar(1.0 + wp * 4.4);
      waveMat.opacity = (1.0 - wp) * 0.42;
    }
    const beam = t >= 1.56 && t <= 2.75;
    verticalOut.uniforms.uProgress.value = beam ? clamp01((t - 1.56) / 0.78) * 1.34 : -0.45;
    verticalOut.uniforms.uBaseAlpha.value = beam ? 0.38 : 0.18;

    crown.forEach((anchor, i) => {
      const at = anchor.clone();
      if (!still) at.y += Math.sin(now * 1.9 + i * 1.3) * 0.025;
      place(tokens[i], at, i === activeIdx ? (t < 0.58 ? 1.06 : 1.03) : 0.96);
    });
    place(tagBrowser, browserTagAt, 1.0);
    place(tagServer, serverTagAt, 1.0);
    if (tagBrowser) tagBrowser.style.opacity = dual || still ? "0.95" : "0.38";
    if (tagServer) tagServer.style.opacity = dual || still ? "0.95" : "0.38";
    const lockedWindow = t >= 1.55 && t <= 2.85;
    if (pill) {
      pill.style.borderColor = lockedWindow ? "#60A5FA" : "#DBEAFE";
      pill.style.backgroundColor = lockedWindow ? "#EFF6FF" : "rgba(255,255,255,0.9)";
    }
    if (pillDot) pillDot.style.transform = lockedWindow ? "scale(1.35)" : "scale(1)";
    renderer.render(scene, camera);
  }

  // Motion policy: a loop only while motion is allowed, the hero is on screen and the tab visible.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let inView = true;
  let frameId = 0;
  let running = false;
  const loop = () => {
    if (!running) return;
    frameId = requestAnimationFrame(loop);
    step(performance.now() * 0.001, false);
  };
  const still = () => step(performance.now() * 0.001, true);
  function schedule() {
    const play = !reduce.matches && inView && document.visibilityState === "visible";
    if (play && !running) {
      running = true;
      cycleOrigin = performance.now() * 0.001;
      prevCycle = 0;
      frameId = requestAnimationFrame(loop);
    } else if (!play && running) {
      running = false;
      cancelAnimationFrame(frameId);
    }
    if (!running && inView) still();
  }

  fit();
  activate(0);
  const refit = () => {
    if (fit() && !running) still();
  };
  // The element's own size (ResizeObserver) and the window (rotation) decide; the visual
  // viewport (pinch-zoom, keyboard, Safari's bars) does not change the stage.
  window.addEventListener("resize", refit);
  // A pixel-ratio change (another screen, browser zoom) redraws at the new density.
  const watchPixelRatio = () => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.(
      "change",
      () => {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        refit();
        watchPixelRatio();
      },
      { once: true },
    );
  };
  watchPixelRatio();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(refit);
    observer.observe(root);
    observer.observe(slot);
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      schedule();
    }).observe(root);
  }
  document.addEventListener("visibilitychange", schedule);
  reduce.addEventListener?.("change", schedule);

  // A tapped channel (or the cube) runs its signal now; in a still hero it redraws once.
  const request = (idx: number) => {
    requestedIdx = idx;
    if (!running) step(performance.now() * 0.001, true);
  };
  tokens.forEach((el, i) => el?.addEventListener("click", () => request(i)));

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;
  root.addEventListener("pointerdown", (event) => { down = { x: event.clientX, y: event.clientY }; });
  root.addEventListener("pointermove", (event) => {
    const rect = root.getBoundingClientRect();
    tiltY = ((event.clientX - rect.left) / Math.max(fullW, 1) * 2 - 1) * 0.18;
    tiltX = ((event.clientY - rect.top) / Math.max(fullH, 1) * 2 - 1) * 0.1;
  });
  root.addEventListener("pointerup", (event) => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 8 && event.target === canvas) {
      const rect = root.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / Math.max(fullW, 1)) * 2 - 1, -((event.clientY - rect.top) / Math.max(fullH, 1)) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObjects([shell, letterA], false).length) request((activeIdx + 1) % 3);
    }
    down = null;
  });
  // A pinch or a scroll the browser takes over is no tap.
  root.addEventListener("pointercancel", () => { down = null; });

  schedule();
  root.classList.add("is-live");
  return true;
}
