/**
 * The adsbook.id product mark and wordmark (2026-11-17): one place for their
 * URLs. They live under a new path, not the old `/images/adsbook-icon.svg`:
 * `/images/*` is served `max-age=86400, stale-while-revalidate=604800`
 * (`public/_headers`), so a browser that had the open-book file kept showing
 * it after the file changed at the same URL. A future change to the art gets
 * a new file name here, never new bytes under an old name.
 *
 * The favicons keep their well-known paths (browsers ask for `/favicon.ico`
 * themselves); the `?v=` query makes the `<link>`ed copies a new URL.
 */
export const BRAND_MARK = "/images/brand/adsbook-mark.svg";
export const BRAND_WORDMARK = "/images/brand/adsbook-wordmark.svg";
export const BRAND_WORDMARK_ON_DARK = "/images/brand/adsbook-wordmark-on-dark.svg";
/** The wordmark that draws itself (the platform home's signal band); /hello replays it on a loop. */
export const BRAND_WORDMARK_ANIMATED = "/platform/brand/adsbook-id-wordmark-animated.svg";

const FAVICON_VERSION = "2";
export const FAVICON_PNG = `/favicon.png?v=${FAVICON_VERSION}`;
export const FAVICON_ICO = `/favicon.ico?v=${FAVICON_VERSION}`;
export const FAVICON_192 = `/favicon-192.png?v=${FAVICON_VERSION}`;
