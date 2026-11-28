/**
 * A 402 from the subscription gate (ADR-041, `subscriptionRefusalBody`): the
 * store is in Preview Mode or past its grace. The admin forms that can meet
 * it (lead conversion, custom domain) carry the code on the thrown error and
 * show this link, so the seller is one tap from Langganan.
 */
export const SUBSCRIPTION_CODES = new Set(["SUBSCRIPTION_REQUIRED", "SUBSCRIPTION_EXPIRED"]);

export class AdminRequestError extends Error {
  readonly code: string | null;
  constructor(message: string, code: unknown) {
    super(message);
    this.name = "AdminRequestError";
    this.code = typeof code === "string" ? code : null;
  }
}

export const isSubscriptionError = (error: unknown) =>
  error instanceof AdminRequestError && error.code !== null && SUBSCRIPTION_CODES.has(error.code);

export function SubscriptionLink({ className = "" }: { className?: string }) {
  return (
    <a href="/admin/billing" className={`font-semibold underline underline-offset-4 ${className}`} data-subscription-link>
      Buka Langganan →
    </a>
  );
}
