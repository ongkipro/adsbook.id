// Borderless gallery review (2026-11-18): the pricing showcase sends a seller to the plan they
// picked. The visible readout follows the radio through CSS :has(); its data-active mark, set by
// the component's script, is what a browser without :has() shows, so both are checked.
import { expect, test } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

test("pricing: 1 Tahun is chosen first, and picking 1 Bulan shows its own signup link", async ({ page }) => {
  await page.goto(`${PLATFORM}/harga`);
  const visibleCta = page.locator(".readout:visible a.r-cta");
  await expect(visibleCta).toHaveCount(1);
  await expect(visibleCta).toHaveAttribute("href", "/daftar?paket=12m");

  await page.locator("label.cycle", { hasText: "1 Bulan" }).click();
  await expect(page.locator('input[name="pricing-plan"][value="1m"]')).toBeChecked();
  await expect(visibleCta).toHaveCount(1);
  await expect(visibleCta).toHaveAttribute("href", "/daftar?paket=1m");
  await expect(page.locator('.readout[data-active="true"]')).toHaveAttribute("data-plan", "1m");
  await expect(page.locator(".readout[data-active]")).toHaveCount(1);

  // Keyboard: arrows move the radio group, and the link follows.
  await page.locator('input[name="pricing-plan"][value="1m"]').press("ArrowDown");
  await expect(visibleCta).toHaveAttribute("href", "/daftar?paket=3m");
  await expect(page.locator('.readout[data-active="true"]')).toHaveAttribute("data-plan", "3m");
});
