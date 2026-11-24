/**
 * The admin sidebar keeps its place across page loads. Every menu item is a
 * full page load, so without this the menu snapped back to the top and the
 * item the operator just clicked jumped away from under the pointer (Paduka,
 * 2026-11-17: "sidebar tidak stay dan kegeser ke atas").
 *
 * On a click in the menu the link's href and its distance from the top of the
 * menu viewport are kept in sessionStorage (this tab only). The next page puts
 * that same link back at that same distance — before the first paint, from an
 * inline script in the sidebar (`SIDEBAR_SCROLL_RESTORE`) — even when a
 * submenu above it opened or closed. On a direct load (bookmark, search,
 * address bar) the current page's item is scrolled above the floating product
 * card at the foot of the sidebar (`bottomInset`, the menu's bottom padding).
 * Nothing about the store or the account is stored.
 *
 * Seller desktop sidebar only (opts in with `data-restore-pad` on its content):
 * when a sub-list *below* the clicked link closed (leaving a Pengaturan page for
 * Plugin or Pembayaran), the shorter menu has no room to scroll the link back
 * under the pointer. The restore then pads the menu's foot through
 * `--sidebar-restore-pad` on <html> — outside every React root, so nothing
 * hydration owns changes — and keeps the link inside the clear area above the
 * footer card even when the window got shorter. Without the opt-in (the
 * platform console) the restore behaves exactly as before.
 */
export const SIDEBAR_SCROLL_KEY = "adsbook:sidebar-place";

export type SidebarPlace = { href: string; y: number; scroll: number };

/** A stored value back to a place, or null when it is not one. */
export function parseSidebarPlace(raw: string | null | undefined): SidebarPlace | null {
  if (!raw || raw.length > 400) return null;
  try {
    const value = JSON.parse(raw) as Partial<SidebarPlace>;
    if (typeof value.href !== "string" || !value.href.startsWith("/") || value.href.startsWith("//")) return null;
    if (!Number.isFinite(value.y) || !Number.isFinite(value.scroll) || (value.scroll as number) < 0) return null;
    return { href: value.href, y: Number(value.y), scroll: Number(value.scroll) };
  } catch {
    return null;
  }
}

/**
 * The scroll offset to apply (null: leave it at 0). Offsets are measured from
 * the top of the menu's content, independent of scrolling.
 *
 * - `clicked`: where the clicked link now sits; it goes back to `place.y` so
 *   nothing moves under the pointer.
 * - otherwise the stored scroll offset, clamped to this menu's height.
 * - `active`: the current page's item, kept inside the clear area above the
 *   floating footer (`clientHeight - bottomInset`) whenever the click itself
 *   did not place it.
 */
export function sidebarScrollTarget(
  place: SidebarPlace | null,
  view: { scrollHeight: number; clientHeight: number; bottomInset?: number },
  clicked: { top: number } | null,
  active: { top: number; bottom: number } | null,
  margin = 8,
): number | null {
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  let target = place ? (clicked ? clicked.top - place.y : place.scroll) : 0;
  target = Math.min(Math.max(0, target), max);
  if (active && !clicked) {
    const clearBottom = Math.max(margin * 2, view.clientHeight - Math.max(margin, view.bottomInset ?? 0));
    if (active.top - target < margin) target = Math.max(0, active.top - margin);
    else if (active.bottom - target > clearBottom) target = Math.min(max, active.bottom - clearBottom);
  }
  return target > 0 ? Math.round(target) : null;
}

/**
 * The inline script, run while the page is parsed, right after the menu's
 * markup and before the first paint. Self-contained (no imports); it mirrors
 * `parseSidebarPlace` and `sidebarScrollTarget` above, which carry the tests.
 */
export const SIDEBAR_SCROLL_RESTORE = `(() => {
  const key = ${JSON.stringify(SIDEBAR_SCROLL_KEY)};
  const content = document.querySelector('[data-slot="sidebar"] [data-sidebar="content"]');
  // The icon rail (768-1023px) does not scroll.
  if (!content || content.closest('[data-collapsible="icon"]')) return;
  const box = content.getBoundingClientRect();
  const offset = (el) => { const r = el.getBoundingClientRect(); return { top: r.top - box.top + content.scrollTop, bottom: r.bottom - box.top + content.scrollTop }; };
  let place = null;
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    const value = raw && raw.length <= 400 ? JSON.parse(raw) : null;
    if (value && typeof value.href === 'string' && value.href.startsWith('/') && !value.href.startsWith('//') && Number.isFinite(value.y) && Number.isFinite(value.scroll) && value.scroll >= 0) place = value;
  } catch {}
  const links = Array.from(content.querySelectorAll('a[href]'));
  const link = place ? links.find((a) => a.getAttribute('href') === place.href) : null;
  const current = content.querySelector('[aria-current="page"]') || content.querySelector('[data-active]:not([data-active="false"])');
  let max = Math.max(0, content.scrollHeight - content.clientHeight);
  let target = place ? (link ? offset(link).top - place.y : place.scroll) : 0;
  if (link && content.hasAttribute('data-restore-pad')) {
    // The clicked link goes back to its place, bounded to the clear area above the footer card.
    const at = offset(link);
    const inset = parseFloat(getComputedStyle(content).paddingBottom) || 0;
    const y = Math.max(8, Math.min(place.y, content.clientHeight - Math.max(8, inset) - (at.bottom - at.top)));
    target = at.top - y;
    if (target > max) {
      document.documentElement.style.setProperty('--sidebar-restore-pad', Math.ceil(target - max) + 'px');
      max = Math.max(0, content.scrollHeight - content.clientHeight);
    }
  }
  target = Math.min(Math.max(0, target), max);
  if (current && !link) {
    const item = offset(current);
    const inset = parseFloat(getComputedStyle(content).paddingBottom) || 0;
    const clearBottom = Math.max(16, content.clientHeight - Math.max(8, inset));
    if (item.top - target < 8) target = Math.max(0, item.top - 8);
    else if (item.bottom - target > clearBottom) target = Math.min(max, item.bottom - clearBottom);
  }
  if (target > 0) content.scrollTop = Math.round(target);
  content.addEventListener('click', (event) => {
    const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!a || !content.contains(a)) return;
    const r = a.getBoundingClientRect();
    const top = content.getBoundingClientRect().top;
    try { sessionStorage.setItem(key, JSON.stringify({ href: a.getAttribute('href'), y: Math.round(r.top - top), scroll: Math.round(content.scrollTop) })); } catch {}
  });
})();`;
