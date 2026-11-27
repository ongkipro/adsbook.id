/**
 * How a lead's follow-up status reads on the abandoned-orders queue: one
 * coloured label per status, so "not yet contacted" stands out from the rest
 * instead of being the palest chip on the row (owner, 2026-11-27).
 *
 * The colour carries urgency, not judgement: "Belum dihubungi" is amber (needs
 * action), "Sudah dihubungi" blue (in progress), "Berminat" green (warm),
 * "Tidak berminat" grey (closed, not an error). The word always carries the
 * meaning; colour is never the only signal.
 *
 * Pure and browser-safe: no D1, so the admin island can import it.
 */
import { LEAD_FOLLOW_UP_LABELS, LEAD_FOLLOW_UP_STATUSES, type LeadFollowUpStatus } from "./abandoned-lead.ts";

export { LEAD_FOLLOW_UP_LABELS, LEAD_FOLLOW_UP_STATUSES, type LeadFollowUpStatus };

/** Tailwind classes per status: a tinted label with a solid dot. Contrast ≥ 4.5:1 for the text on its tint. */
export const LEAD_FOLLOW_UP_TONE: Record<LeadFollowUpStatus, { label: string; dot: string }> = {
  new: { label: "border-amber-200 bg-amber-50 text-amber-900", dot: "bg-amber-500" },
  contacted: { label: "border-sky-200 bg-sky-50 text-sky-900", dot: "bg-sky-500" },
  qualified: { label: "border-emerald-200 bg-emerald-50 text-emerald-900", dot: "bg-emerald-500" },
  not_interested: { label: "border-slate-200 bg-slate-100 text-slate-700", dot: "bg-slate-400" },
};

/**
 * The status label's own shape, owned here like FILTER_TRIGGER_CLASS owns the
 * filter triggers' (DESIGN-SYSTEM §7.1): callers add only a tone from
 * LEAD_FOLLOW_UP_TONE. It carries the 2px accent focus ring every admin
 * control draws (a data-slot element gets no fallback outline).
 */
export const LEAD_STATUS_TRIGGER_CLASS =
  "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export function isLeadFollowUpStatus(value: unknown): value is LeadFollowUpStatus {
  return typeof value === "string" && (LEAD_FOLLOW_UP_STATUSES as readonly string[]).includes(value);
}

/** Same number as ABANDONED_RETENTION_DAYS in order-persistence.ts; lead-follow-up.test.ts pins the two together. */
export const LEAD_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * "2 jam lalu", "3 hari lalu": how long a lead has waited, the number a
 * follow-up queue is worked by. Null for an unreadable or future time.
 */
export function leadAge(createdAt: string | null | undefined, now = new Date()): string | null {
  const at = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(at) || at > now.getTime() + 60_000) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

/**
 * Whole days left before the 30-day purge (ADR-042) deletes the lead, shown only when
 * fewer than three remain (2, 1, then 0 = today) so an operator sees which
 * leads are about to disappear. Null earlier, and for an unreadable time.
 */
export function leadDaysLeft(createdAt: string | null | undefined, now = new Date()): number | null {
  const at = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  // Whole days still ahead: under a day reads as 0 ("today"), never "1 day" for a few minutes.
  const left = Math.floor((at + LEAD_RETENTION_DAYS * DAY_MS - now.getTime()) / DAY_MS);
  return left < 3 ? Math.max(0, left) : null;
}
