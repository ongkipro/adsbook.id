/**
 * The admin topbar's icon controls (bell, status, profile, mobile search):
 * borderless and shadowless so the bar stays quiet; 44px touch target on phones
 * (WCAG 2.2 / UX contract), 36px on desktop.
 */
export const TOPBAR_ICON_BUTTON =
  "relative grid size-11 shrink-0 place-items-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 md:size-9";

/** The count on a topbar icon: small, ringed white so it reads on any hover tint. */
export const TOPBAR_BADGE =
  "absolute right-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-xs font-semibold leading-none text-white ring-2 ring-white md:-right-0.5 md:-top-0.5";
