import * as React from "react";
import { ChevronDown, ChevronRight, LogOut, Menu, Search, Store, UserRound } from "lucide-react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ADMIN_ACCENT } from "../admin/admin-navigation";
import { TOPBAR_ICON_BUTTON } from "../admin/topbar-styles";
import type { PlatformRole } from "../../platform/admin/session";
import { PlatformSidebar } from "./PlatformSidebar";
import { getVisiblePlatformGroups, PLATFORM_ROLE_LABEL, type PlatformMenu } from "./platform-navigation";

/**
 * The platform console's shell (T-52): the seller admin's AdminShell layout —
 * shadcn Sidebar, a quiet topbar with ⌘K search, an account menu, a bottom
 * navigation and a menu sheet on phones, the 1560px content box — built from
 * the same primitives and accent, with the console's own menu. The page
 * content stays server-rendered by Astro and is passed in as children.
 *
 * ⌘K also jumps to a store: typing a slug offers "Buka toko <slug>", which
 * opens the store list filtered by it.
 */
export function PlatformShell({
  children,
  title,
  description,
  active,
  email,
  role,
  sidebarDefaultOpen = true,
}: {
  children: React.ReactNode;
  title: string;
  description?: string;
  active: PlatformMenu;
  email: string;
  role: PlatformRole;
  sidebarDefaultOpen?: boolean;
}) {
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [isDesktop, setIsDesktop] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(sidebarDefaultOpen);
  const [signingOut, setSigningOut] = React.useState(false);
  const groups = getVisiblePlatformGroups(role);
  const items = groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));
  const mobilePrimary = items.filter((item) => ["overview", "tenants", "billing"].includes(item.id));
  const menuIsActive = !mobilePrimary.some((item) => item.id === active);
  const roleLabel = PLATFORM_ROLE_LABEL[role];
  const storeQuery = searchQuery.trim().toLowerCase().replace(/[^a-z0-9.@-]/g, "").slice(0, 64);

  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const updateViewport = () => setIsDesktop(media.matches);
    // Remembered like the seller admin's, so the server renders the rail or the
    // full menu this width needs and the sidebar does not resize after load.
    const updateSidebar = () => {
      setSidebarOpen(wide.matches);
      document.cookie = `sidebar_state=${wide.matches}; path=/; max-age=604800; samesite=lax`;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    updateViewport();
    updateSidebar();
    media.addEventListener("change", updateViewport);
    wide.addEventListener("change", updateSidebar);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      media.removeEventListener("change", updateViewport);
      wide.removeEventListener("change", updateSidebar);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleSearchOpenChange = (open: boolean) => {
    setSearchOpen(open);
    if (!open) setSearchQuery("");
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch("/api/platform/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout");
      window.location.assign("/platform/login");
    } catch {
      setSigningOut(false);
    }
  };

  const searchContent = (
    <>
      <div className="border-b border-slate-200 bg-slate-50/70 p-2">
        <div className="rounded-lg border border-slate-300 bg-white shadow-sm focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-200">
          <CommandInput value={searchQuery} onValueChange={setSearchQuery} aria-label="Cari menu atau toko" placeholder="Ketik menu, slug toko, atau email owner…" className="h-11" autoFocus />
        </div>
      </div>
      <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-2 sm:max-h-[min(55vh,28rem)]">
        <CommandEmpty className="px-4 py-14 text-center">
          <p className="font-semibold text-slate-900">Tidak ada menu yang cocok</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Coba tagihan, domain, aktivitas, atau ketik slug toko.</p>
        </CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.label} heading={group.label}>
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.description} ${item.keywords} ${group.label}`}
                onSelect={() => {
                  handleSearchOpenChange(false);
                  window.location.assign(item.href);
                }}
                className="min-h-14 px-3 py-2.5"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
                  <item.icon className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{item.label}</span>
                  <span className="block truncate text-xs text-slate-500">{item.description}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden="true" />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {storeQuery.length >= 2 && (
          <CommandGroup heading="Toko">
            <CommandItem
              value={`toko ${storeQuery} ${searchQuery}`}
              onSelect={() => {
                handleSearchOpenChange(false);
                window.location.assign(`/platform/tenants?q=${encodeURIComponent(storeQuery)}`);
              }}
              className="min-h-14 px-3 py-2.5"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
                <Store className="size-[18px]" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900">Cari toko “{storeQuery}”</span>
                <span className="block truncate text-xs text-slate-500">Slug, domain, atau email owner</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden="true" />
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="hidden items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-500 sm:flex">
        <span>↑↓ Pilih hasil</span>
        <span>Enter untuk buka · Esc untuk tutup</span>
      </div>
    </>
  );

  return (
    <TooltipProvider>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <PlatformSidebar active={active} role={role} />
        <SidebarInset className="min-w-0 bg-transparent">
          <header className="admin-topbar sticky top-0 z-30 flex h-[60px] shrink-0 items-center border-b border-slate-200/70 bg-white/90 px-3 backdrop-blur-xl md:h-16 md:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
              <button type="button" onClick={() => setMenuOpen(true)} className={`${TOPBAR_ICON_BUTTON} md:hidden`} aria-label="Buka menu navigasi">
                <Menu className="size-5" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-tight text-slate-950">{title}</h1>
                <p className="hidden truncate text-xs font-medium text-slate-500 lg:block">{description ?? "Console platform adsbook.id"}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="group mx-4 hidden h-9 w-full max-w-md flex-1 items-center gap-2.5 rounded-lg bg-slate-100/80 px-3 text-left text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 md:flex xl:mx-6"
            >
              <Search className="size-4 text-slate-400 transition-colors group-hover:text-slate-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Cari menu atau toko…</span>
              <kbd className="rounded bg-white px-1.5 py-0.5 font-sans text-xs font-medium text-slate-400 ring-1 ring-slate-200">⌘K</kbd>
            </button>

            <div className="flex flex-1 items-center justify-end gap-1">
              <button type="button" onClick={() => setSearchOpen(true)} className={`${TOPBAR_ICON_BUTTON} md:hidden`} aria-label="Cari menu atau toko">
                <Search className="size-[18px]" aria-hidden="true" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="ml-1 flex h-9 shrink-0 items-center gap-2 rounded-full pl-0.5 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 data-popup-open:bg-slate-100 lg:pr-2.5"
                  aria-label={`Menu akun (${roleLabel})`}
                >
                  <span className="grid size-8 place-items-center rounded-full bg-slate-900 text-white" aria-hidden="true">
                    <UserRound className="size-4" />
                  </span>
                  <span className="hidden text-sm font-medium lg:inline">{role === "platform_owner" ? "Owner" : "Support"}</span>
                  <ChevronDown className="hidden size-3.5 text-slate-400 lg:block" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="w-64">
                  <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-900 text-white" aria-hidden="true">
                      <UserRound className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{email}</span>
                      <span className="block truncate text-xs font-normal text-slate-500">{roleLabel}</span>
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={signingOut} onClick={(event) => { event.preventDefault(); void signOut(); }}>
                    <LogOut aria-hidden="true" />
                    {signingOut ? "Keluar…" : "Keluar"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <div id="platform-main" tabIndex={-1} className="admin-main min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-[calc(5.25rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:pb-8 md:pt-6 xl:px-8">
            <div className="mx-auto w-full max-w-[1560px]">{children}</div>
          </div>

          <nav aria-label="Navigasi utama mobile" className="admin-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/80 bg-white/95 shadow-[0_-8px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div className="grid h-16 items-stretch" style={{ gridTemplateColumns: `repeat(${mobilePrimary.length + 1}, minmax(0, 1fr))` }}>
              {mobilePrimary.map((item) => {
                const isActive = active === item.id;
                return (
                  <a key={item.id} href={item.href} aria-current={isActive ? "page" : undefined} className={`flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 ${isActive ? "font-medium text-slate-950" : "font-normal text-slate-500"}`}>
                    <span className="relative grid size-8 place-items-center rounded-xl transition-colors" style={isActive ? { backgroundColor: `${ADMIN_ACCENT}14`, color: ADMIN_ACCENT } : undefined}>
                      <item.icon className="size-[19px]" aria-hidden="true" />
                      {isActive && <span className="absolute -bottom-1 h-0.5 w-3 rounded-full" style={{ backgroundColor: ADMIN_ACCENT }} aria-hidden="true" />}
                    </span>
                    <span className="w-full truncate text-center">{item.label}</span>
                  </a>
                );
              })}
              <button id="platform-mobile-menu-trigger" type="button" onClick={() => setMenuOpen(true)} aria-current={menuIsActive ? "page" : undefined} aria-label="Buka semua menu" className={`flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 ${menuIsActive ? "font-medium text-slate-950" : "font-normal text-slate-500"}`}>
                <span className="relative grid size-8 place-items-center rounded-xl" style={menuIsActive ? { backgroundColor: `${ADMIN_ACCENT}14`, color: ADMIN_ACCENT } : undefined}>
                  <Menu className="size-[19px]" aria-hidden="true" />
                  {menuIsActive && <span className="absolute -bottom-1 h-0.5 w-3 rounded-full" style={{ backgroundColor: ADMIN_ACCENT }} aria-hidden="true" />}
                </span>
                <span>Menu</span>
              </button>
            </div>
          </nav>
        </SidebarInset>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[86dvh] gap-0 overflow-hidden rounded-t-[1.25rem] border-slate-200 bg-white p-0 md:hidden"
            finalFocus={() => document.getElementById("platform-mobile-menu-trigger")}
          >
            <SheetHeader className="border-b border-slate-200 px-4 pb-3 pt-4 text-left">
              <SheetTitle className="text-base font-semibold tracking-tight text-slate-950">Semua menu</SheetTitle>
              <SheetDescription className="text-xs">{email} · {roleLabel}</SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto overscroll-contain px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
              {groups.map((group) => (
                <section key={group.label} className="mb-3">
                  <h2 className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">{group.label}</h2>
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    {group.items.map((item) => {
                      const isActive = active === item.id;
                      return (
                        <a key={item.id} href={item.href} aria-current={isActive ? "page" : undefined} className="flex min-h-13 items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0 active:bg-slate-50">
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600" style={isActive ? { backgroundColor: `${ADMIN_ACCENT}14`, color: ADMIN_ACCENT } : undefined}>
                            <item.icon className="size-4" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-sm text-slate-900 ${isActive ? "font-medium" : "font-normal"}`}>{item.label}</span>
                            <span className="block truncate text-xs text-slate-500">{item.description}</span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden="true" />
                        </a>
                      );
                    })}
                  </div>
                </section>
              ))}
              <button type="button" disabled={signingOut} onClick={() => void signOut()} className="mb-2 flex min-h-13 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-rose-700 active:bg-slate-50">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-rose-50"><LogOut className="size-4" aria-hidden="true" /></span>
                <span className="text-sm">{signingOut ? "Keluar…" : "Keluar"}</span>
              </button>
            </div>
          </SheetContent>
        </Sheet>

        {isDesktop ? (
          <CommandDialog open={searchOpen} onOpenChange={handleSearchOpenChange} title="Pencarian console" description="Cari menu console atau toko." showCloseButton>
            <div className="border-b border-slate-200 px-4 py-3 pr-12">
              <h2 className="text-sm font-semibold tracking-tight text-slate-950">Pencarian console</h2>
              <p className="mt-0.5 text-xs text-slate-500">Lompat ke menu, atau cari toko dengan slug, domain, atau email owner.</p>
            </div>
            {searchContent}
          </CommandDialog>
        ) : (
          <Sheet open={searchOpen} onOpenChange={handleSearchOpenChange}>
            <SheetContent side="bottom" style={{ height: "min(82dvh, 42rem)" }} className="max-h-[calc(100dvh-env(safe-area-inset-top))] gap-0 overflow-hidden rounded-t-[1.25rem] border-slate-200 bg-white p-0">
              <SheetHeader className="border-b border-slate-200 px-4 pb-3 pt-4 pr-12 text-left">
                <SheetTitle className="text-base font-semibold tracking-tight text-slate-950">Pencarian console</SheetTitle>
                <SheetDescription className="text-xs">Cari menu atau toko.</SheetDescription>
              </SheetHeader>
              <Command className="h-auto! min-h-0 flex-1 rounded-none!">{searchContent}</Command>
            </SheetContent>
          </Sheet>
        )}
        <Toaster position="top-center" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
