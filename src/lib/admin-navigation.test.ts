import assert from "node:assert/strict";
import test from "node:test";
import {
  getSearchableNavItems,
  getVisibleNavGroups,
  isAdminNavHrefActive,
} from "../components/admin/admin-navigation.ts";
import { ADMIN_ROLES, canAccessAdminRoute } from "./auth.ts";

test("visible admin navigation never exposes a route denied to its role", () => {
  for (const role of ADMIN_ROLES) {
    const links = getSearchableNavItems(role).map((item) => item.href);
    for (const href of links) {
      assert.equal(
        canAccessAdminRoute(role, new URL(href, "https://admin.local").pathname),
        true,
        `${role} cannot access visible link ${href}`,
      );
    }
  }
});

test("scoped roles see their complete workspace without privileged settings", () => {
  const advertiserItems = getVisibleNavGroups("advertiser").flatMap(
    (group) => group.items,
  );
  assert.deepEqual(
    advertiserItems.map((item) => item.id),
    // "content" is deliberately absent: the storefront content editor is
    // reachable at /admin/content and left out of the menu (ADR-018).
    ["dashboard", "products", "analytics", "ads"],
  );
  assert.equal(
    advertiserItems
      .find((item) => item.id === "products")
      ?.children?.some((child) => child.href === "/admin/landing-pages"),
    true,
  );

  const adminSettings = getVisibleNavGroups("admin")
    .flatMap((group) => group.items)
    .find((item) => item.id === "settings");
  assert.equal(
    adminSettings?.children?.some(
      (child) => child.href === "/admin/settings/access",
    ),
    false,
  );
});

test("navigation active matching keeps required query filters and accepts pagination", () => {
  assert.equal(
    isAdminNavHrefActive(
      "/admin/orders?status=abandoned&page=2",
      "/admin/orders?status=abandoned",
    ),
    true,
  );
  assert.equal(
    isAdminNavHrefActive(
      "/admin/orders?status=paid",
      "/admin/orders?status=abandoned",
    ),
    false,
  );
  assert.equal(
    isAdminNavHrefActive("/admin/landing-pages/12/edit", "/admin/landing-pages"),
    false,
  );
  // A plugin's settings page keeps "Plugin" lit; nothing else matches by prefix.
  assert.equal(isAdminNavHrefActive("/admin/settings/plugins/kelola", "/admin/settings/plugins"), true);
  assert.equal(isAdminNavHrefActive("/admin/settings/pluginsx", "/admin/settings/plugins"), false);
  assert.equal(isAdminNavHrefActive("/admin/settings/plugins/kelola", "/admin/settings/store"), false);
});

test("DIGITAL-PRODUCTS-SPEC §4.1: a digital store's menu drops shipping, couriers, rate check and the warehouse; physical and hybrid keep them", () => {
  const hrefs = (mode: "physical" | "digital" | "hybrid", role: "owner" | "admin" | "customer_service" = "owner") =>
    getVisibleNavGroups(role, mode).flatMap((group) => group.items.flatMap((item) => [item.href, ...(item.children ?? []).map((child) => child.href)]));
  const shipping = ["/admin/shipping", "/admin/expeditions", "/admin/check", "/admin/settings/warehouse"];
  for (const mode of ["physical", "hybrid"] as const) {
    for (const href of shipping) assert.ok(hrefs(mode).includes(href), `${mode} keeps ${href}`);
  }
  for (const role of ["owner", "admin", "customer_service"] as const) {
    for (const href of shipping) assert.ok(!hrefs("digital", role).includes(href), `${role} digital hides ${href}`);
  }
  for (const href of ["/admin/orders", "/admin/products", "/admin/payments", "/admin/ads/tiktok", "/admin/settings/store"]) {
    assert.ok(hrefs("digital").includes(href), `digital keeps ${href}`);
  }
  const search = getSearchableNavItems("owner", "digital").map((item) => item.href);
  for (const href of shipping) assert.ok(!search.includes(href), `search hides ${href}`);
  assert.deepEqual(getVisibleNavGroups("owner"), getVisibleNavGroups("owner", "hybrid"), "the default is today's menu");
});
