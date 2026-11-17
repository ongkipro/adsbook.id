import { cn } from "@/lib/utils";
import { BRAND_MARK } from "@/lib/brand-assets";

// The store's own logo when it uploaded one (Pengaturan › Toko & CS, a square
// WebP); until then the adsbook.id mark (Paduka, 2026-11-17: "default pakai icon
// adsbook aja"). Admin only: the storefront never shows the platform mark for a
// store (UI-1), it falls back to the store name. The deleted placeholder
// wordmark still counts as no logo, should an old store row name it.
const LEGACY_PLACEHOLDER_LOGO = "/images/adsbook-mark.webp";

export function StoreMark({ logo, name, className }: { logo?: string; name: string; className?: string }) {
  const own = logo && logo !== LEGACY_PLACEHOLDER_LOGO ? logo : "";
  return (
    <img
      src={own || BRAND_MARK}
      alt={own ? name : ""}
      width={36}
      height={36}
      className={cn("shrink-0 rounded-lg bg-white object-cover", className)}
    />
  );
}
