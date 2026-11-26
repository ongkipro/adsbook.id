import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowUpRight, BookOpen, History, LogOut, Settings, Store, UserRound } from "lucide-react";
import { AccountFace } from "./AccountButton";

/**
 * The admin account menu: who is signed in, their profile, the store's
 * settings (roles that have them), the storefront, docs, the release notes,
 * and Keluar. AdminShell loads it on the first click on the account button
 * and mounts it open, so the menu code is not in every page's first download.
 */
export function AccountMenu({
  defaultOpen,
  triggerClassName,
  roleLabel,
  showRoleLabel,
  adminUsername,
  storeLabel,
  profileHref,
  profileLabel,
  showSettings,
  showStorefront,
  docsHref,
  version,
  onOpenChangelog,
}: {
  defaultOpen?: boolean;
  triggerClassName: string;
  roleLabel: string;
  showRoleLabel: boolean;
  adminUsername: string;
  storeLabel: string;
  profileHref: string;
  profileLabel: string;
  showSettings: boolean;
  showStorefront: boolean;
  docsHref?: string;
  version: string;
  onOpenChangelog: () => void;
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger className={triggerClassName} aria-label={`Menu akun (${roleLabel})`}>
        <AccountFace label={roleLabel} showLabel={showRoleLabel} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-900 text-white" aria-hidden="true">
            <UserRound className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{adminUsername || roleLabel}</span>
            <span className="block truncate text-xs font-normal text-slate-500">{roleLabel} · {storeLabel}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<a href={profileHref} />}>
              <UserRound aria-hidden="true" />
              {profileLabel}
            </DropdownMenuItem>
          {showSettings && (
            <DropdownMenuItem render={<a href="/admin/settings/store" />}>
                <Settings aria-hidden="true" />
                Pengaturan toko
              </DropdownMenuItem>
          )}
          {showStorefront && (
            <DropdownMenuItem render={<a href="/" target="_blank" rel="noopener noreferrer" />}>
                <Store aria-hidden="true" />
                Lihat storefront
                <ArrowUpRight className="ml-auto text-slate-400" aria-hidden="true" />
              </DropdownMenuItem>
          )}
          {docsHref && (
            <DropdownMenuItem render={<a href={docsHref} />}>
                <BookOpen aria-hidden="true" />
                Docs API & CLI
              </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onOpenChangelog}>
            <History aria-hidden="true" />
            What's new
            <span className="ml-auto font-mono text-xs text-slate-500">v{version}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* The layout's data-logout-form handler does the request and
            relabels the button; the item keeps the menu open meanwhile. */}
        <form method="POST" action="/api/admin/logout" data-logout-form>
          <DropdownMenuItem variant="destructive" closeOnClick={false} render={<button type="submit" className="w-full" />}>
              <LogOut aria-hidden="true" />
              Keluar
            </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
