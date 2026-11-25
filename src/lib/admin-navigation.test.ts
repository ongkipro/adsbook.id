import assert from "node:assert/strict";
import test from "node:test";
import {
  getSearchableNavItems,
  getVisibleNavGroups,
  isAdminNavHrefActive,
} from "../components/admin/admin-navigation.ts";
import { ADMIN_ROLES, canAccessAdminRoute } from "./auth.ts";
import { SETTINGS_GROUPS, SETTINGS_INDEX, visibleSettingsGroups } from "../components/admin/settings-sections.ts";
import {
  ADS_RAIL_GROUPS,
  ANALYTICS_RAIL_GROUPS,
  CHECK_RAIL_GROUPS,
  EXPEDITIONS_RAIL_GROUPS,
  PAYMENTS_RAIL_GROUPS,
  visibleRailGroups,
} from "../components/admin/section-rails.ts";

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

test("Plugin is its own workspace right before Pengaturan for owner and admin, and nowhere for the scoped roles", () => {
  const PLUGINS = "/admin/settings/plugins";
  for (const role of ["owner", "admin"] as const) {
    const system = getVisibleNavGroups(role).find((group) => group.items.some((item) => item.id === "settings"));
    const ids = system?.items.map((item) => item.id) ?? [];
    assert.equal(ids.indexOf("plugins"), ids.indexOf("settings") - 1, `${role}: Plugin sits immediately before Pengaturan`);
    assert.equal(system?.items.find((item) => item.id === "plugins")?.href, PLUGINS, `${role}: same URL as before`);
    const settings = system?.items.find((item) => item.id === "settings");
    assert.equal(settings?.children?.some((child) => child.href === PLUGINS), false, `${role}: no second Plugin entry under Pengaturan`);
    assert.equal(getSearchableNavItems(role).filter((item) => item.href === PLUGINS).length, 1, `${role}: one search result`);
    // A digital store keeps it: plugins are not a shipping surface.
    assert.ok(getVisibleNavGroups(role, "digital").some((group) => group.items.some((item) => item.id === "plugins")), `${role}: digital keeps Plugin`);
  }
  for (const role of ["advertiser", "customer_service"] as const) {
    assert.equal(getSearchableNavItems(role).some((item) => item.href.startsWith(PLUGINS)), false, `${role}: no Plugin link anywhere`);
    assert.equal(canAccessAdminRoute(role, PLUGINS), false, `${role}: and no access to the page`);
  }
  // Operator CS keeps exactly its workspace, Cek WA & Ongkir included.
  assert.deepEqual(getVisibleNavGroups("customer_service").flatMap((group) => group.items.map((item) => item.id)), ["dashboard", "orders", "shipping", "scoring"]);
  // Every plugin page, the list and each plugin's own page, lights the Plugin link.
  assert.equal(isAdminNavHrefActive("/admin/settings/plugins", PLUGINS), true);
  assert.equal(isAdminNavHrefActive("/admin/settings/plugins/kelola", PLUGINS), true);
});

test("Tema sits right above Plugin for owner and admin, opens its beranda page, and is closed to the scoped roles", () => {
  const THEME = "/admin/settings/theme";
  for (const role of ["owner", "admin"] as const) {
    const system = getVisibleNavGroups(role).find((group) => group.items.some((item) => item.id === "plugins"));
    const ids = system?.items.map((item) => item.id) ?? [];
    assert.equal(ids.indexOf("theme"), ids.indexOf("plugins") - 1, `${role}: Tema immediately above Plugin`);
    assert.equal(canAccessAdminRoute(role, THEME), true, `${role}: page`);
    assert.equal(canAccessAdminRoute(role, `${THEME}/beranda`), true, `${role}: beranda`);
    assert.equal(canAccessAdminRoute(role, "/api/admin/settings/theme"), true, `${role}: API`);
    assert.equal(getVisibleNavGroups(role, "digital").some((group) => group.items.some((item) => item.id === "theme")), true, `${role}: a digital store keeps Tema`);
  }
  for (const role of ["advertiser", "customer_service"] as const) {
    assert.equal(getSearchableNavItems(role).some((item) => item.href.startsWith(THEME)), false, `${role}: no Tema link`);
    assert.equal(canAccessAdminRoute(role, THEME), false, `${role}: no page`);
    assert.equal(canAccessAdminRoute(role, "/api/admin/settings/theme"), false, `${role}: no API`);
  }
  assert.equal(isAdminNavHrefActive(`${THEME}/beranda`, THEME), true, "the beranda page lights Tema");
  // "Tampilan toko" left Katalog: the banner lives under Tema now.
  const katalog = getVisibleNavGroups("owner").flatMap((group) => group.items).find((item) => item.id === "products");
  assert.equal(katalog?.children?.some((child) => child.href === "/admin/content/tampilan"), false);
});

test("Pengaturan's rail lists only sections the role may open, and the sidebar's Pengaturan children are that same list", () => {
  const hrefs = (role: (typeof ADMIN_ROLES)[number], mode?: "physical" | "digital" | "hybrid") =>
    visibleSettingsGroups(role, mode).flatMap((group) => group.items.map((item) => item.href));
  for (const role of ADMIN_ROLES) {
    for (const href of hrefs(role)) assert.equal(canAccessAdminRoute(role, href), true, `${role}: ${href}`);
  }
  assert.equal(hrefs("owner").includes("/admin/settings/access"), true);
  assert.equal(hrefs("admin").includes("/admin/settings/access"), false, "an admin never sees Akses pengguna");
  assert.deepEqual(hrefs("customer_service"), [], "a scoped role has no settings rail");
  assert.equal(hrefs("owner", "digital").includes("/admin/settings/warehouse"), false, "a digital store has no warehouse");
  assert.equal(hrefs("owner", "physical").includes("/admin/settings/warehouse"), true);

  // No section twice, and the overview first.
  const all = SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.href));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all[0], SETTINGS_INDEX);

  // One list: the phone menu sheet and the search read the sidebar item's children.
  for (const role of ["owner", "admin"] as const) {
    const settings = getVisibleNavGroups(role).flatMap((group) => group.items).find((item) => item.id === "settings");
    assert.equal(settings?.sectionRail, true);
    assert.deepEqual(settings?.children?.map((child) => child.href), hrefs(role).filter((href) => href !== SETTINGS_INDEX), role);
  }
});

test("Section rails stay aligned with navigation and role rules, while Pesanan and Katalog keep sidebar tree submenus", () => {
  const specs = [
    { id: "expeditions", groups: EXPEDITIONS_RAIL_GROUPS, indexHref: "/admin/expeditions" },
    { id: "scoring", groups: CHECK_RAIL_GROUPS, indexHref: "/admin/check" },
    { id: "analytics", groups: ANALYTICS_RAIL_GROUPS, indexHref: null },
    { id: "ads", groups: ADS_RAIL_GROUPS, indexHref: "/admin/ads" },
    { id: "payments", groups: PAYMENTS_RAIL_GROUPS, indexHref: "/admin/payments" },
  ] as const;

  for (const spec of specs) {
    const all = spec.groups.flatMap((group) => group.items.map((item) => item.href));
    assert.equal(new Set(all).size, all.length, `${spec.id}: no duplicate hrefs`);
    for (const role of ADMIN_ROLES) {
      const visible = visibleRailGroups(spec.groups, role).flatMap((group) => group.items.map((item) => item.href));
      for (const href of visible) {
        assert.equal(canAccessAdminRoute(role, href), true, `${spec.id}/${role}: ${href}`);
      }
      const navItem = getVisibleNavGroups(role).flatMap((group) => group.items).find((item) => item.id === spec.id);
      if (navItem) {
        assert.equal(navItem.sectionRail, true, `${spec.id}: desktop sidebar stays flat`);
        const expectedChildren = spec.indexHref ? visible.filter((href) => href !== spec.indexHref) : visible;
        assert.deepEqual(navItem.children?.map((child) => child.href), expectedChildren, `${spec.id}/${role} children match rail`);
      }
    }
  }

  // Pesanan and Katalog intentionally keep desktop tree sub-menus (Paduka, 2026-11-25).
  const ownerItems = getVisibleNavGroups("owner").flatMap((group) => group.items);
  assert.equal(ownerItems.find((item) => item.id === "orders")?.sectionRail, undefined);
  assert.equal(ownerItems.find((item) => item.id === "products")?.sectionRail, undefined);
});
