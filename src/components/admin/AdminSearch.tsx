import { ChevronRight } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { withInsightsPeriod } from "@/lib/insights-view";
import type { getSearchableNavItems } from "./admin-navigation";

type SearchItem = ReturnType<typeof getSearchableNavItems>[number];

/**
 * The admin search palette (desktop dialog, phone sheet). Its own module so
 * AdminShell loads it, and cmdk with it, only when the search first opens:
 * every admin page used to download it for a box most visits never open.
 */
export function AdminSearch({
  open,
  onOpenChange,
  isDesktop,
  query,
  onQueryChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktop: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  items: SearchItem[];
}) {
  const searchContent = (
    <>
      <div className="border-b border-slate-200 bg-slate-50/70 p-2">
        <div className="rounded-lg border border-slate-300 bg-white shadow-sm focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-200">
          <CommandInput
            value={query}
            onValueChange={onQueryChange}
            aria-label="Cari halaman admin"
            placeholder="Ketik nama halaman atau tugas…"
            className="h-11"
            autoFocus
          />
        </div>
      </div>
      <CommandList className="max-h-none flex-1 overflow-y-auto px-2 py-2 sm:max-h-[min(55vh,28rem)]">
        <CommandEmpty className="px-4 py-14 text-center">
          <p className="font-semibold text-slate-900">Tidak ada halaman yang cocok</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Coba istilah seperti order, resi, gudang, CRM, Meta, atau payment.
          </p>
        </CommandEmpty>
        {Array.from(new Set(items.map((item) => item.group))).map((groupName) => (
          <CommandGroup key={groupName} heading={groupName}>
            {items.filter((item) => item.group === groupName).map((item) => (
              <CommandItem
                key={`${item.href}-${item.label}`}
                value={`${item.label} ${item.description} ${item.keywords} ${item.group}`}
                onSelect={() => {
                  onOpenChange(false);
                  window.location.assign(withInsightsPeriod(item.href, window.location.pathname, window.location.search));
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
      </CommandList>
      <div className="hidden items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-500 sm:flex">
        <span>↑↓ Pilih hasil</span>
        <span>Enter untuk buka · Esc untuk tutup</span>
      </div>
    </>
  );

  return isDesktop ? (
          <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Pencarian admin"
            description="Cari halaman dan pengaturan yang tersedia untuk akun ini."
            showCloseButton
          >
            <div className="border-b border-slate-200 px-4 py-3 pr-12">
              <h2 className="text-sm font-semibold tracking-tight text-slate-950">Pencarian admin</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Cari order, pengiriman, produk, tracking, atau pengaturan.
              </p>
            </div>
            {searchContent}
          </CommandDialog>
        ) : (
          <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="bottom" style={{ height: "min(82dvh, 42rem)" }} className="max-h-[calc(100dvh-env(safe-area-inset-top))] gap-0 overflow-hidden rounded-t-[1.25rem] border-slate-200 bg-white p-0">
              <SheetHeader className="border-b border-slate-200 px-4 pb-3 pt-4 pr-12 text-left">
                <SheetTitle className="text-base font-semibold tracking-tight text-slate-950">Pencarian admin</SheetTitle>
                <SheetDescription className="text-xs">
                  Cari order, pengiriman, produk, tracking, atau pengaturan.
                </SheetDescription>
              </SheetHeader>
              <Command className="h-auto! min-h-0 flex-1 rounded-none!">
                {searchContent}
              </Command>
            </SheetContent>
          </Sheet>
  );
}
