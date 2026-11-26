import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical shadcn/ui table frame for seller admin lists (IBM Carbon + Shopify
 * Polaris IndexTable pattern): one bordered white surface uniting the toolbar,
 * count/meta bar, desktop table or mobile card stack, and pagination footer.
 */
export function DataTableShell({
  toolbar,
  meta,
  footer,
  children,
  className,
}: {
  toolbar?: React.ReactNode;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="data-table-shell"
      className={cn("overflow-hidden rounded-xl border border-slate-200 bg-white", className)}
    >
      {toolbar && (
        <div className="border-b border-slate-100 p-4">
          {toolbar}
        </div>
      )}
      {meta && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
          {meta}
        </div>
      )}
      {children}
      {footer && (
        <div className="border-t border-slate-100 px-4 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}
