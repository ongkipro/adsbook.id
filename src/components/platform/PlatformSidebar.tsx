import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ADMIN_ACCENT } from "../admin/admin-navigation";
import { CMS_VERSION } from "@/lib/version";
import type { PlatformRole } from "../../platform/admin/session";
import { getVisiblePlatformGroups, type PlatformMenu } from "./platform-navigation";
import { SIDEBAR_SCROLL_RESTORE } from "@/lib/sidebar-scroll";
import { BRAND_MARK, BRAND_WORDMARK } from "@/lib/brand-assets";

/**
 * The console's sidebar: the seller admin's AppSidebar look (same primitives,
 * accent, active rail, group labels and floating product card), with the
 * platform's own menu and no store data.
 */
export function PlatformSidebar({ active, role }: { active: PlatformMenu; role: PlatformRole }) {
  const groups = getVisiblePlatformGroups(role);
  return (
    <Sidebar variant="sidebar" collapsible="icon" className="border-r-0">
      <SidebarHeader className="px-3 pb-2 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="adsbook.id platform" className="h-14 rounded-xl px-2 hover:bg-sidebar-accent">
              <a href="/platform" aria-label="Buka ringkasan platform">
                <img src={BRAND_MARK} alt="" width="36" height="36" className="size-9 shrink-0 rounded-xl" />
                <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5 text-left leading-tight">
                  <img src={BRAND_WORDMARK} alt="" width="94" height="15" className="h-[15px] w-auto" />
                  <span className="sr-only">adsbook.id</span>
                  <span className="truncate text-xs text-slate-500">Console platform</span>
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2 pb-20 group-data-[collapsible=icon]:pb-20">
        {groups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel className="mb-0.5 h-6 px-2 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400">{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const isActive = active === item.id;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className="relative h-9 rounded-lg px-2.5 font-normal text-slate-600 hover:bg-slate-100 hover:text-slate-950 data-[active=true]:font-medium group-data-[collapsible=icon]:size-10!"
                      style={isActive ? { backgroundColor: `${ADMIN_ACCENT}12`, color: ADMIN_ACCENT } : undefined}
                    >
                      <a href={item.href} aria-current={isActive ? "page" : undefined}>
                        {isActive && <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full" style={{ backgroundColor: ADMIN_ACCENT }} aria-hidden="true" />}
                        <item.icon className="size-[17px]" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {/* Before the first paint: the menu stays where the operator left it (src/lib/sidebar-scroll.ts). */}
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_SCROLL_RESTORE }} />

      <SidebarFooter className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-2 *:pointer-events-auto">
        <div className="flex items-center justify-between gap-2.5 rounded-xl border border-white/70 bg-white/55 px-2.5 py-2 shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] ring-1 ring-slate-900/5 backdrop-blur-md backdrop-saturate-150 group-data-[collapsible=icon]:hidden">
          <img src={BRAND_WORDMARK} alt="adsbook.id" width="94" height="15" className="h-[15px] w-auto shrink-0" />
          <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 font-mono text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/15">v{CMS_VERSION.version}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
