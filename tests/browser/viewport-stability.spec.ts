// iOS viewport localization (2026-11-19 brief, stage B), local only. Safari's own
// toolbar and keyboard cannot be reproduced here (Chromium has no dynamic bars,
// and WebKit is not installed): this measures what the page controls. The hero
// keeps its frame while only the visual viewport changes, refits for a real
// geometry change (rotation), keeps its canvas and call to action aligned to its
// own box while the page scrolls; the auth studio scrolls naturally when it is
// taller than a short screen.
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

const shots = process.env.VIEWPORT_SHOT_DIR;

/** Records every write of the canvas's size attributes (a resize clears its buffer). */
async function watchCanvas(page: Page) {
  await page.evaluate(() => {
    const canvas = document.getElementById("stage-canvas")!;
    (window as unknown as { __canvasWrites: number }).__canvasWrites = 0;
    new MutationObserver((records) => {
      (window as unknown as { __canvasWrites: number }).__canvasWrites += records.length;
    }).observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  });
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __canvasWrites: number }).__canvasWrites);
/** Canvas and call to action relative to the hero's own box, not to the scrolled page. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById("hero-root")!.getBoundingClientRect();
    const canvas = document.getElementById("stage-canvas")!.getBoundingClientRect();
    const cta = document.querySelector("#copy-inner a.cta-modern")!.getBoundingClientRect();
    return {
      height: Math.round(root.height),
      canvas: [canvas.left - root.left, canvas.top - root.top, canvas.width - root.width, canvas.height - root.height].map(Math.round),
      cta: [Math.round(cta.left - root.left), Math.round(cta.top - root.top)],
      ctaInside: cta.bottom <= root.bottom && cta.top >= root.top,
    };
  });

test("home hero: a visual-viewport change leaves the stage alone, rotation refits it, scrolling keeps canvas and CTA in the hero's frame", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PLATFORM}/`);
  await page.waitForFunction(() => document.getElementById("hero-root")?.classList.contains("is-live") || document.getElementById("hero-root")?.classList.contains("is-still"));
  await page.waitForTimeout(400);
  const first = await frame(page);
  expect(first.canvas, "the canvas fills the hero").toEqual([0, 0, 0, 0]);
  expect(first.ctaInside, "the call to action inside the first screen").toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/vp-hero-390.png` });

  // Pinch-zoom, the keyboard or Safari's bars move the visual viewport only: no canvas resize.
  await watchCanvas(page);
  await page.evaluate(() => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(200);
  expect(await writes(page), "an unchanged geometry never resizes the canvas").toBe(0);

  // Scrolling down and back: the hero's frame and its contents do not move relative to it.
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(250);
  const scrolled = await frame(page);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(250);
  expect(scrolled.canvas).toEqual(first.canvas);
  expect(scrolled.cta).toEqual(first.cta);
  expect(scrolled.height).toBe(first.height);
  expect(await writes(page), "scrolling never refits").toBe(0);

  // Rotation is a real geometry change: the stage refits to the new box.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => writes(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await frame(page)).canvas).toEqual([0, 0, 0, 0]);
  const rotated = await page.evaluate(() => {
    const root = document.getElementById("hero-root")!;
    const canvas = document.getElementById("stage-canvas") as HTMLCanvasElement;
    return { root: root.clientWidth, canvas: canvas.width / Math.min(window.devicePixelRatio || 1, 2) };
  });
  expect(rotated.canvas).toBe(rotated.root);
  if (shots) await page.screenshot({ path: `${shots}/vp-hero-844x390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await frame(page)).canvas).toEqual([0, 0, 0, 0]);
  expect((await frame(page)).ctaInside).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/vp-hero-1440.png` });
});

test("auth studio: one screen at default size, natural vertical scroll on a short screen (landscape, keyboard-sized), zoom left free", async ({ page }) => {
  for (const path of ["/masuk", "/daftar"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${PLATFORM}${path}`);
    const fits = await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    expect(fits, `${path}: one screen at 390×844`).toBe(true);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport, "pinch zoom is never disabled").not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);

    // Short screens: a phone on its side, and a portrait screen with the keyboard's height taken.
    for (const [width, height] of [[844, 390], [390, 480]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      const box = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: innerHeight, sideways: document.documentElement.scrollWidth > innerWidth, studio: document.querySelector("[data-auth-studio]")!.getBoundingClientRect().height }));
      expect(box.sideways, `${path} ${width}×${height}: no sideways scroll`).toBe(false);
      expect(box.studio, `${path} ${width}×${height}: the studio is at least the screen`).toBeGreaterThanOrEqual(box.inner - 1);
      // Whatever does not fit is reached by scrolling, not clipped.
      const action = page.locator(path === "/masuk" ? "#loginSubmit" : "#toStep2");
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport();
      if (shots && path === "/daftar" && width === 844) await page.screenshot({ path: `${shots}/vp-daftar-844x390.png` });
    }
  }
  // Focus in a field on a short screen keeps it in view (the keyboard case, as far as a resize models it).
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto(`${PLATFORM}/daftar`);
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  await page.getByLabel("Alamat toko", { exact: true }).focus();
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeInViewport();
  if (shots) await page.screenshot({ path: `${shots}/vp-daftar-390x480.png` });
});

test("home hero: a pinch that starts on the stage zooms the page, and the call to action is never clipped — landscape, narrow, larger text", async ({ page }) => {
  for (const [width, height, text] of [[844, 390, null], [568, 320, null], [320, 568, "150%"], [390, 844, "200%"], [844, 390, "150%"]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${PLATFORM}/`);
    // Larger text, as a reader's text-size setting scales the rem-based copy.
    if (text) await page.addStyleTag({ content: `html { font-size: ${text} !important; }` });
    await page.waitForTimeout(400);
    const label = `${width}×${height}${text ? ` text ${text}` : ""}`;
    await expect(page.locator("#stage-canvas")).toHaveCSS("touch-action", "pan-y pinch-zoom");
    const fit = await page.evaluate(() => {
      const root = document.getElementById("hero-root")!.getBoundingClientRect();
      const ui = document.querySelector(".layer-ui") as HTMLElement;
      const cta = document.querySelector("#copy-inner a.cta-modern")!.getBoundingClientRect();
      const canvas = document.getElementById("stage-canvas")!.getBoundingClientRect();
      return { overflow: ui.scrollHeight - ui.clientHeight, inside: cta.top >= root.top && cta.bottom <= root.bottom, canvasCovers: Math.round(canvas.height) === Math.round(root.height), height: root.height, viewport: innerHeight };
    });
    expect(fit.overflow, `${label}: nothing in the hero overflows its box`).toBeLessThanOrEqual(0);
    expect(fit.inside, `${label}: the call to action lies inside the hero, not clipped`).toBe(true);
    expect(fit.height, `${label}: at least the first screen (or 520px)`).toBeGreaterThanOrEqual(Math.min(Math.max(520, fit.viewport), 520) - 1);
    await expect.poll(async () => page.evaluate(() => Math.round(document.getElementById("stage-canvas")!.getBoundingClientRect().height) === Math.round(document.getElementById("hero-root")!.getBoundingClientRect().height)), { message: `${label}: the stage still covers the hero` }).toBe(true);
    // Below the fold is fine: it is reached by scrolling.
    const cta = page.locator("#copy-inner a.cta-modern");
    await cta.scrollIntoViewIfNeeded();
    const seen = await cta.evaluate((element) => { const box = element.getBoundingClientRect(); return box.top >= -1 && box.bottom <= innerHeight + 1; });
    expect(seen, `${label}: the whole call to action can be scrolled into view`).toBe(true);
    if (shots && (text || width === 844)) await page.screenshot({ path: `${shots}/vp-hero-cta-${width}x${height}${text ? `-text${text.replace("%", "")}` : ""}.png` });
  }
});
