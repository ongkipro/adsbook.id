import { ChevronDown, UserRound } from "lucide-react";

/**
 * The account menu's trigger face. AdminShell renders it as a plain button
 * until the first click, then the same face inside AccountMenu's real
 * trigger, so the top bar looks identical before and after the menu loads.
 */
export function AccountFace({ label, showLabel }: { label: string; showLabel: boolean }) {
  return (
    <>
      <span className="grid size-8 place-items-center rounded-full bg-slate-900 text-white" aria-hidden="true">
        <UserRound className="size-4" />
      </span>
      {showLabel && <span className="hidden text-sm font-medium lg:inline">{label}</span>}
      <ChevronDown className="hidden size-3.5 text-slate-400 lg:block" aria-hidden="true" />
    </>
  );
}

export function AccountButton({ className, label, showLabel, onClick }: { className: string; label: string; showLabel: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={className} aria-label={`Menu akun (${label})`} aria-haspopup="menu" aria-expanded={false} onClick={onClick}>
      <AccountFace label={label} showLabel={showLabel} />
    </button>
  );
}
