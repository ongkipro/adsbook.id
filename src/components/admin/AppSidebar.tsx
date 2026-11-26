import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { BookOpen, ChevronRight, History } from "lucide-react";
import {
  ADMIN_ACCENT,
  getVisibleNavGroups,
  isAdminNavHrefActive,
  profileNavItem,
  type AdminRole,
  type CatalogMode,
} from "./admin-navigation";
import { CMS_VERSION } from "@/lib/version";
import { SIDEBAR_SCROLL_RESTORE } from "@/lib/sidebar-scroll";
import { BRAND_WORDMARK } from "@/lib/brand-assets";


export function AppSidebar({
  activeMenu,
  currentPath,
  adminRole,
  catalogMode = "hybrid",
  restricted = false,
  wideLayout = false,
  onWideLayoutChange,
  onOpenChangelog,
  docsHref,
}: {
  activeMenu: string;
  currentPath: string;
  siteUrl?: string;
  adminName: string;
  siteName?: string;
  siteLogo?: string;
  adminRole: AdminRole;
  catalogMode?: CatalogMode;
  restricted?: boolean;
  wideLayout?: boolean;
  onWideLayoutChange?: (next: boolean) => void;
  onOpenChangelog?: () => void;
  /** Set only for a role that may open /admin/docs. */
  docsHref?: string;
}) {
  const docsActive = Boolean(docsHref) && (currentPath === docsHref || currentPath.startsWith(`${docsHref}/`));
  const groups = restricted ? [] : getVisibleNavGroups(adminRole, catalogMode);

  return (
    <Sidebar variant="sidebar" collapsible="icon" contained className="border-r border-slate-200/70">
      {/* data-restore-pad: the scroll restore may pad the full desktop menu's foot (src/lib/sidebar-scroll.ts). */}
      <SidebarContent data-restore-pad="" className="px-2 pb-[calc(0.75rem+var(--sidebar-restore-pad,0px))] pt-3 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:pb-3">
        {restricted && (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel className="mb-0.5 h-6 px-2 text-xs font-medium uppercase tracking-wider text-slate-500">
              Keamanan akun
            </SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive tooltip={profileNavItem.label} className="h-9 rounded-lg bg-white px-2.5 font-medium shadow-xs ring-1 ring-slate-200/80 data-active:bg-white group-data-[collapsible=icon]:size-10!" style={{ color: ADMIN_ACCENT }} render={<a href={profileNavItem.href} aria-current="page" />}>
                  <profileNavItem.icon className="size-[17px]" aria-hidden="true" />
                  <span>{profileNavItem.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
        {groups.map((group, groupIndex) => (
          <SidebarGroup
            key={group.label}
            className={`py-1.5 ${groupIndex > 0 ? "group-data-[collapsible=icon]:border-t group-data-[collapsible=icon]:border-slate-200/80" : ""}`}
          >
            <SidebarGroupLabel className="mb-0.5 h-6 px-2 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const active = activeMenu === item.id;
                // A section-rail item (Pengaturan, Payments, etc.) lists its pages beside the page, not here.
                const children = item.sectionRail ? [] : item.children ?? [];
                const activeChild = children.find((child) =>
                  isAdminNavHrefActive(currentPath, child.href),
                );
                const overviewActive = !activeChild && isAdminNavHrefActive(currentPath, item.href);
                const itemStyle = active ? { color: ADMIN_ACCENT } : undefined;

                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={children.length > 0 ? `${item.label} · memiliki submenu` : item.label}
                      className={`relative h-9 rounded-lg px-2.5 font-normal group-data-[collapsible=icon]:size-10! ${
                        active
                          ? "bg-white font-medium shadow-xs ring-1 ring-slate-200/80 hover:bg-white data-active:bg-white data-active:hover:bg-white"
                          : "text-slate-600 hover:bg-white/80 hover:text-slate-950"
                      }`}
                      style={itemStyle}
                      render={<a href={item.href} aria-current={overviewActive ? "page" : undefined} />}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full"
                          style={{ backgroundColor: ADMIN_ACCENT }}
                          aria-hidden="true"
                        />
                      )}
                      <item.icon className="size-[17px]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                        {children.length > 0 && <span className="sr-only"> · memiliki submenu</span>}
                      </span>
                      {children.length > 0 && (
                        <ChevronRight
                          className={`ml-auto size-3.5 shrink-0 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0.5 group-data-[collapsible=icon]:top-0.5 group-data-[collapsible=icon]:size-2.5 ${active ? "rotate-90" : ""}`}
                          aria-hidden="true"
                        />
                      )}
                    </SidebarMenuButton>
                    {active && children.length > 0 && (
                      <SidebarMenuSub className="mr-0 gap-0.5 border-slate-200/90 py-1">
                        {children.map((child) => {
                          const childActive = isAdminNavHrefActive(currentPath, child.href);

                          return (
                            <SidebarMenuSubItem key={child.href}>
                              <SidebarMenuSubButton
                                isActive={childActive}
                                className="h-8 rounded-md px-2 text-sm font-normal text-slate-600 hover:bg-white/70 hover:text-slate-950 data-active:font-medium data-active:text-blue-700"
                                render={<a href={child.href} aria-current={childActive ? "page" : undefined} />}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`size-1.5 shrink-0 rounded-full ${childActive ? "bg-blue-600" : "bg-slate-300"}`}
                                />
                                <span>{child.label}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* Quiet in-flow footer: never overlaps menu items, offers the Layar Lebar toggle on wide monitors (>= 1480px). */}
      <SidebarFooter className="shrink-0 border-t border-slate-200/70 p-2">
        <SidebarMenu className="hidden gap-1 group-data-[collapsible=icon]:flex">
          {docsHref && (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={docsActive}
                tooltip="Docs · API & CLI"
                className="h-9 hover:bg-white"
                render={<a href={docsHref} aria-current={docsActive ? "page" : undefined} />}
              >
                <BookOpen aria-hidden="true" />
                <span>Docs</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {onOpenChangelog && (
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                onClick={onOpenChangelog}
                tooltip={`What's new · adsbook.id v${CMS_VERSION.version}`}
                className="h-9 hover:bg-white"
              >
                <History aria-hidden="true" />
                <span>v{CMS_VERSION.version}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>

        <div className="space-y-1.5 group-data-[collapsible=icon]:hidden">
          {onWideLayoutChange && (
            <div className="hidden items-center justify-between gap-2 rounded-lg px-2 py-1.5 min-[1480px]:flex">
              <label htmlFor="admin-wide-layout-switch" className="cursor-pointer text-xs font-medium text-slate-600">
                Layar lebar
              </label>
              <Switch
                id="admin-wide-layout-switch"
                checked={wideLayout}
                onCheckedChange={onWideLayoutChange}
                aria-label="Mode layar lebar"
              />
            </div>
          )}
          <div className="rounded-lg border border-slate-200/80 bg-white px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 pb-1.5">
              <img src={BRAND_WORDMARK} alt="adsbook.id" width="88" height="14" className="h-[14px] w-auto shrink-0" />
              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-600">
                v{CMS_VERSION.version}
              </span>
            </div>
            {(docsHref || onOpenChangelog) && (
              <div className={docsHref && onOpenChangelog ? "grid grid-cols-2 gap-1" : "grid grid-cols-1 gap-1"}>
                {docsHref && (
                  <a
                    href={docsHref}
                    aria-current={docsActive ? "page" : undefined}
                    className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 ${docsActive ? "bg-slate-900 text-white" : "bg-slate-50 text-slate-700 hover:bg-slate-100 hover:text-slate-950"}`}
                  >
                    <BookOpen className="size-3.5" aria-hidden="true" />
                    Docs
                  </a>
                )}
                {onOpenChangelog && (
                  <button
                    type="button"
                    onClick={onOpenChangelog}
                    className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-slate-50 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                  >
                    <History className="size-3.5" aria-hidden="true" />
                    What's new
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </SidebarFooter>
      {/* Before the first paint, after SidebarFooter is in the DOM so SidebarContent's
          flex-1 clientHeight reflects the exact clear height above the footer. */}
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_SCROLL_RESTORE }} />
    </Sidebar>
  );
}
