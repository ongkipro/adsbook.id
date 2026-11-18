/**
 * The storefront's one call into TikTok, for the bundled form scripts
 * (`form-hybrid.ts`, `form-middle.ts`). `TikTokPixelBase` defines
 * `__PS_TIKTOK_TRACK__` only when the store has a valid pixel and ad signals
 * are not paused (ADR-041), so on every other store this is a no-op.
 */

export type TikTokFunnelProduct = {
  /** The catalogue id (`catalogProductId`), the same `content_id` the feed and CompletePayment carry. */
  contentId?: string;
  contentName?: string;
  value?: number;
};

/** TikTok's `properties` for a funnel event: one product, quantity one, IDR. */
export function tiktokFunnelProperties(product: TikTokFunnelProduct) {
  const value = Number.isFinite(Number(product.value)) ? Math.max(0, Number(product.value)) : 0;
  const contentId = String(product.contentId ?? "").trim();
  const contentName = String(product.contentName ?? "").trim().slice(0, 200) || undefined;
  return {
    contents: contentId ? [{ content_id: contentId, content_name: contentName, price: value, quantity: 1 }] : undefined,
    content_type: "product" as const,
    value,
    currency: "IDR" as const,
  };
}

export function trackTikTokFunnel(
  eventName: "ViewContent" | "AddToCart" | "InitiateCheckout",
  product: TikTokFunnelProduct,
  eventId: string,
  phone?: string,
) {
  const track = (globalThis as { __PS_TIKTOK_TRACK__?: unknown }).__PS_TIKTOK_TRACK__;
  if (typeof track !== "function") return;
  track(eventName, tiktokFunnelProperties(product), eventId, phone ? { phone } : undefined);
}
