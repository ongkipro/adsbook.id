// /daftar step 1 timing under a local latency fixture (2026-11-19): the address
// check is delayed on its way to the real local server, and the time from the
// seller's Enter to step 2 is measured. A fixture, not a live SLA. With
// SLUG_TIMING_OUT set the measurements are written there as JSON.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

/** Every availability check for addresses matching `pattern` takes `ms` (or never answers). */
async function delayChecks(page: Page, pattern: RegExp, ms: number | "never", seen: string[] = []) {
  await page.route(pattern, async (route) => {
    seen.push(new URL(route.request().url()).searchParams.get("slug") ?? "");
    if (ms === "never") return; // left hanging: the page must decide without it
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined); // an aborted check has nothing to continue
  });
  return seen;
}

const ready = (page: Page) => page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
const NOT_CONFIRMED = "Belum sempat dicek; diperiksa lagi saat toko dibuat.";
const NOTE_PENDING = "Alamat toko belum sempat dicek; diperiksa lagi saat toko dibuat.";
const NOTE_TAKEN = "Alamat toko ternyata tidak tersedia; kembali ke langkah 1 untuk menggantinya.";
const shots = process.env.AUTH2_SHOT_DIR;
/**
 * The form column slides in on load (`studio-in`: translateY(8px) over 240 ms,
 * ease-out), so a position read before that ends still carries a residual —
 * about 0.59 px at 100 ms — that later reads do not. Resolves once every
 * animation on `selector` and its ancestors has finished; it waits for the
 * entrance only, never for anything the status line does.
 */
const entranceSettled = (page: Page, selector: string) =>
  page.locator(selector).evaluate(async (element) => {
    const running: Animation[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) running.push(...node.getAnimations());
    await Promise.all(running.map((animation) => animation.finished));
  });
/** The first request of a fresh local server is slow (cold start); measure warm. */
const warm = (page: Page) => page.evaluate(() => fetch("/api/platform/slug?slug=pemanasan-cek").then((response) => response.status));

/** Types the address and presses Enter at once; returns ms until step 2 (or null) and the hint then. */
async function enterTiming(page: Page, slug: string, timeout = 15_000) {
  await page.getByLabel("Alamat toko", { exact: true }).fill(slug);
  const started = Date.now();
  await page.keyboard.press("Enter");
  const moved = await page.locator("#stepNow").filter({ hasText: "2" }).waitFor({ timeout }).then(() => Date.now() - started, () => null);
  return { ms: moved, hint: (await page.locator("#slugHint").textContent())?.trim() ?? "" };
}

test("measure: Enter right after typing, at 50 / 400 / 3000 ms and a check that never answers (3 runs each, warm)", async ({ page }) => {
  test.setTimeout(240_000);
  const results: Array<Record<string, unknown>> = [];
  for (const [latency, base] of [[50, "ukur-cepat"], [400, "ukur-biasa"], [3000, "ukur-lambat"], ["never", "ukur-hilang"]] as const) {
    const runs: Array<{ ms: number | null; hint: string; requests: number }> = [];
    for (let run = 1; run <= 3; run += 1) {
      const slug = `${base}-${run}`;
      const seen = await delayChecks(page, new RegExp(`/api/platform/slug\\?slug=${slug}`), latency);
      await page.goto(`${PLATFORM}/daftar`);
      await ready(page);
      await warm(page);
      runs.push({ ...(await enterTiming(page, slug, 15_000)), requests: seen.length });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    const sorted = runs.map((run) => run.ms ?? Infinity).sort((a, b) => a - b);
    results.push({ latency, medianMs: sorted[1], runsMs: runs.map((run) => run.ms), hints: runs.map((run) => run.hint), requests: runs.map((run) => run.requests) });
  }
  console.log(JSON.stringify(results));
  if (process.env.SLUG_TIMING_OUT) writeFileSync(process.env.SLUG_TIMING_OUT, JSON.stringify(results, null, 1));
  expect(results).toHaveLength(4);
});

test("fast: Enter right after typing runs the pending check at once (one request) and moves on with its answer; the status line never moves the form", async ({ page }) => {
  const seen = await delayChecks(page, /\/api\/platform\/slug\?slug=cek-cepat/, 50);
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await warm(page);
  const address = page.getByLabel("Alamat toko", { exact: true });
  const next = page.locator("#toStep2");
  await entranceSettled(page, "#toStep2");
  const before = (await next.boundingBox())!.y;
  // Layout: "checking" and a result take the reserved line, the button stays put.
  await address.fill("cek-tata-letak");
  await expect(page.locator("#slugHint")).toHaveText("Memeriksa…");
  expect(Math.abs((await next.boundingBox())!.y - before), "checking does not push the button").toBeLessThan(0.5);
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 5_000 });
  expect(Math.abs((await next.boundingBox())!.y - before), "a result does not move it either").toBeLessThan(0.5);

  // Timing: the request leaves at Enter, not after the 240 ms typing pause, and only once.
  let requestAt = 0;
  page.on("request", (request) => { if (request.url().includes("slug=cek-cepat") && !requestAt) requestAt = Date.now(); });
  await address.fill("cek-cepat");
  const enterAt = Date.now();
  await page.keyboard.press("Enter");
  await page.locator("#stepNow").filter({ hasText: "2" }).waitFor({ timeout: 5_000 });
  const moved = Date.now() - enterAt;
  expect(requestAt - enterAt, `request ${requestAt - enterAt} ms after Enter`).toBeLessThan(150);
  // It moved on the answer, not on the deadline (the local server's own time varies run to run).
  expect(moved, `Enter → step 2 in ${moved} ms`).toBeLessThan(1_200);
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia");
  expect(seen, "the pending check ran once, not again after its timer").toEqual(["cek-cepat"]);
});

test("slow or silent: Continue waits one short deadline, then moves on saying honestly it is not confirmed — never 'available' without an answer", async ({ page }) => {
  for (const [latency, slug] of [[3000, "cek-lambat"], ["never", "cek-hilang"]] as const) {
    await delayChecks(page, new RegExp(`/api/platform/slug\\?slug=${slug}`), latency);
    await page.goto(`${PLATFORM}/daftar`);
    await ready(page);
    await warm(page);
    const timing = await enterTiming(page, slug);
    expect(timing.ms!, `${latency}: step 2 in ${timing.ms} ms`).toBeLessThan(1_700);
    expect(timing.hint, `${latency}: no claim without an answer`).toBe(NOT_CONFIRMED);
    // Step 1's line is out of sight now: step 2 says it, briefly, without repeating the address.
    await expect(page.locator("#slugNote")).toBeVisible();
    await expect(page.locator("#slugNote")).toHaveText(NOTE_PENDING);
    await expect(page.locator("#slugNote")).not.toContainText(slug);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("the deadline counts from the press: an edit while waiting starts a new check but does not extend the wait, and the newest address is the one judged", async ({ page }) => {
  const seen = await delayChecks(page, /\/api\/platform\/slug\?slug=tunda-/, 3000);
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await warm(page);
  const address = page.getByLabel("Alamat toko", { exact: true });
  await address.fill("tunda-satu");
  const started = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await address.fill("tunda-dua");
  await page.locator("#stepNow").filter({ hasText: "2" }).waitFor({ timeout: 5_000 });
  const elapsed = Date.now() - started;
  expect(elapsed, `decided ${elapsed} ms after the press, not 1.2 s after the edit`).toBeLessThan(1_700);
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(address).toHaveValue("tunda-dua");
  await expect(page.locator("#slugHint")).toHaveText(NOT_CONFIRMED);
  expect(seen).toEqual(["tunda-satu", "tunda-dua"]);
});

test("stale answers are cancelled: a slow 'taken' for the old address never lands on the new one", async ({ page }) => {
  // The first address answers "taken" 1.5 s late; the second answers normally.
  await page.route(/\/api\/platform\/slug\?slug=lama-basi/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, data: { available: false, reason: "Alamat toko ini tidak tersedia.", suggestions: ["lama-basi-2"] } }) }).catch(() => undefined);
  });
  const cancelled: string[] = [];
  page.on("requestfailed", (request) => { if (request.url().includes("slug=lama-basi")) cancelled.push(request.failure()?.errorText ?? ""); });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  const address = page.getByLabel("Alamat toko", { exact: true });
  await address.fill("lama-basi");
  await page.waitForTimeout(400); // its request is now in flight
  await address.fill("baru-segar");
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 5_000 });
  await page.waitForTimeout(1_500);
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia");
  await expect(page.locator("#slugSuggestions")).toBeHidden();
  expect(cancelled, "the old request was cancelled, not just ignored").toHaveLength(1);
});

test("known unavailable blocks at once; back and forward re-checks an address left unconfirmed", async ({ page }) => {
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await warm(page);
  const address = page.getByLabel("Alamat toko", { exact: true });
  await address.fill("admin");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
  const started = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  expect(Date.now() - started, "no wait for a known answer").toBeLessThan(500);
  await expect(page.locator("#stepNow")).toHaveText("1");

  // Unconfirmed on the way forward (the first check never answers), then back and forward again:
  // the stuck request is cancelled and a fresh one answers.
  let checks = 0;
  const cancelled: string[] = [];
  page.on("requestfailed", (request) => { if (request.url().includes("slug=maju-mundur")) cancelled.push(request.url()); });
  await page.route(/\/api\/platform\/slug\?slug=maju-mundur/, async (route) => {
    checks += 1;
    if (checks === 1) return; // the first one hangs
    await route.continue();
  });
  const first = await enterTiming(page, "maju-mundur");
  expect(first.hint).toBe(NOT_CONFIRMED);
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(page.locator("#slugHint")).toHaveText(NOT_CONFIRMED);
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2");
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(page.locator("#slugHint"), "checked again on the way forward").toHaveText("✓ Tersedia");
  expect(checks, "one fresh check").toBe(2);
  expect(cancelled, "the stuck request was cancelled").toHaveLength(1);
});

test("the step-2 note follows the address: a late 'available' removes it, a late 'unavailable' says so, a failed check reads the same, a new address clears it", async ({ page }) => {
  test.setTimeout(90_000);
  const note = page.locator("#slugNote");
  const next = page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" });
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    // A late "available" (2 s): the note shows at the deadline, then goes.
    await delayChecks(page, new RegExp(`/api/platform/slug\\?slug=telat-ada-${width}`), 2_000);
    await page.goto(`${PLATFORM}/daftar`);
    await ready(page);
    await warm(page);
    await enterTiming(page, `telat-ada-${width}`);
    await expect(note).toHaveText(NOTE_PENDING);
    await page.getByLabel("Nama toko").focus();
    if (shots) await page.screenshot({ path: `${shots}/slug-pending-s2-${width}.png` });
    // The answer is 2 s late on top of the local server's own (variable) time.
    await expect(note, "a late 'available' removes the note").toBeHidden({ timeout: 8_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }

  // A late "unavailable": the note changes to say so.
  await page.route(/\/api\/platform\/slug\?slug=telat-tidak/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, data: { available: false, reason: "Alamat toko ini tidak tersedia.", suggestions: [] } }) }).catch(() => undefined);
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await enterTiming(page, "telat-tidak");
  await expect(note).toHaveText(NOTE_PENDING);
  await expect(note).toHaveText(NOTE_TAKEN, { timeout: 8_000 });
  if (shots) await page.screenshot({ path: `${shots}/slug-taken-late-s2-1440.png` });
  // Back to step 1: the address's own line carries the reason, the note is gone; a new address clears it for good.
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(note).toBeHidden();
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
  await page.getByLabel("Alamat toko", { exact: true }).fill("ganti-alamat-baru");
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 5_000 });
  await next.click();
  await expect(page.locator("#stepNow")).toHaveText("2");
  await expect(note, "a confirmed address needs no note").toBeHidden();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A failed check reads exactly like a missed deadline, in step 1 and in step 2.
  await page.route(/\/api\/platform\/slug\?slug=cek-gagal-jaringan/, (route) => route.abort("failed"));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await page.getByLabel("Alamat toko", { exact: true }).fill("cek-gagal-jaringan");
  await expect(page.locator("#slugHint")).toHaveText(NOT_CONFIRMED, { timeout: 5_000 });
  await next.click();
  await expect(page.locator("#stepNow")).toHaveText("2", { timeout: 3_000 });
  await expect(note).toHaveText(NOTE_PENDING);
});
