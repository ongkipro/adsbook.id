import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSidebarPlace, SIDEBAR_SCROLL_KEY, SIDEBAR_SCROLL_RESTORE, sidebarScrollTarget } from "./sidebar-scroll.ts";

test("a stored sidebar place is only ever an in-site href and two numbers", () => {
  assert.deepEqual(parseSidebarPlace('{"href":"/admin/settings/access","y":534,"scroll":276}'), { href: "/admin/settings/access", y: 534, scroll: 276 });
  for (const raw of [null, undefined, "", "276", "{", '{"href":"https://x.test","y":1,"scroll":0}', '{"href":"//x.test","y":1,"scroll":0}', '{"href":"/a","y":"1","scroll":0}', '{"href":"/a","y":1,"scroll":-5}', `{"href":"/${"a".repeat(500)}","y":1,"scroll":0}`]) {
    assert.equal(parseSidebarPlace(raw), null, String(raw));
  }
});

test("the clicked item comes back under the pointer, even when a submenu above it changed", () => {
  const view = { scrollHeight: 996, clientHeight: 720 };
  const place = { href: "/admin/settings/access", y: 534, scroll: 276 };
  // Same menu: the link is where it was, so is the scroll.
  assert.equal(sidebarScrollTarget(place, view, { top: 810 }, { top: 810, bottom: 842 }), 276);
  // A submenu above closed (40px shorter): scroll 40px less, the item stays put.
  assert.equal(sidebarScrollTarget(place, view, { top: 770 }, { top: 770, bottom: 802 }), 236);
  // The link is gone from this page's menu: fall back to the stored scroll.
  assert.equal(sidebarScrollTarget(place, view, null, null), 276);
  // Clamped to the menu's height.
  assert.equal(sidebarScrollTarget({ ...place, scroll: 900 }, view, null, null), 276);
});

test("the current page's item is always inside the menu viewport", () => {
  const view = { scrollHeight: 996, clientHeight: 720 };
  // Opened from search or a bookmark: scroll just enough to show it.
  assert.equal(sidebarScrollTarget(null, view, null, { top: 830, bottom: 866 }), 154);
  // A stored place that would hide it above the fold.
  assert.equal(sidebarScrollTarget({ href: "/x", y: 0, scroll: 276 }, view, null, { top: 100, bottom: 136 }), 92);
  // Nothing to do at the top.
  assert.equal(sidebarScrollTarget(null, view, null, { top: 40, bottom: 76 }), null);
  assert.equal(sidebarScrollTarget(null, { scrollHeight: 500, clientHeight: 720 }, null, null), null);
});

test("the restore script runs inline before paint, in both shells, and keeps its key", () => {
  assert.ok(SIDEBAR_SCROLL_RESTORE.includes(JSON.stringify(SIDEBAR_SCROLL_KEY)));
  assert.doesNotMatch(SIDEBAR_SCROLL_RESTORE, /\bimport\b|\bexport\b/);
  assert.doesNotThrow(() => new Function(SIDEBAR_SCROLL_RESTORE));
  for (const file of ["src/components/admin/AppSidebar.tsx", "src/components/platform/PlatformSidebar.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /<script dangerouslySetInnerHTML=\{\{ __html: SIDEBAR_SCROLL_RESTORE \}\} \/>/, `${file} inlines the restore`);
    assert.ok(source.indexOf("SIDEBAR_SCROLL_RESTORE }}") > source.indexOf("</SidebarContent>"), `${file}: after the menu's markup`);
  }
});
