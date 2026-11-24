import * as React from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { FILTER_TRIGGER_CLASS } from "./filter-bar";
import {
  ADMIN_CUSTOM_DATE_FILTER,
  formatAdminDateRangeLabel,
  getAdminDateFilterLabel,
} from "../../lib/admin-date-filter";

export type AdminDateSelection = {
  filter: string;
  start: string;
  end: string;
};

export type AdminDateRangeProps = {
  value: AdminDateSelection;
  onChange: (value: AdminDateSelection) => void;
  disabled?: boolean;
  /** Presets this surface does not offer, e.g. the dashboard hides 90d/180d. */
  hiddenPresets?: readonly string[];
  /** Longest custom range this surface can answer for. */
  maxCustomRangeDays?: number;
  className?: string;
};

export function adminDateSelectionLabel(value: AdminDateSelection) {
  if (value.filter !== ADMIN_CUSTOM_DATE_FILTER) {
    return getAdminDateFilterLabel(value.filter);
  }
  return value.start && value.end
    ? formatAdminDateRangeLabel(value.start, value.end)
    : "Rentang tanggal";
}

// The presets and two-month calendar (AdminDateRangePanel, a Base UI Menu)
// load on the first click; until then a plain button with the same face shows
// the period in force. The dashboard and Insights render this above the fold.
const AdminDateRangePanel = React.lazy(() => import("./AdminDateRangePanel").then((module) => ({ default: module.AdminDateRangePanel })));

export function AdminDateRangeFilter(props: AdminDateRangeProps) {
  const [loaded, setLoaded] = React.useState(false);
  const button = (onClick?: () => void) => (
    <button
      type="button"
      disabled={props.disabled}
      aria-haspopup="menu"
      aria-expanded={false}
      className={`${FILTER_TRIGGER_CLASS} ${props.className ?? ""}`}
      onClick={onClick}
    >
      <CalendarDays className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{adminDateSelectionLabel(props.value)}</span>
      <ChevronDown className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
    </button>
  );
  if (!loaded) return button(() => setLoaded(true));
  return (
    <React.Suspense fallback={button()}>
      <AdminDateRangePanel {...props} />
    </React.Suspense>
  );
}
