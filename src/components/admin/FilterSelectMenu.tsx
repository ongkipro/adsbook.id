import type * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FILTER_TRIGGER_CLASS, type FilterOption } from "./filter-bar";

/** FilterSelect's list, loaded on the first click and mounted open (filter-bar.tsx). */
export function FilterSelectMenu({
  id,
  label,
  disabled,
  face,
  value,
  options,
  onValueChange,
}: {
  id: string;
  label?: string;
  disabled?: boolean;
  face: React.ReactNode;
  value: string;
  options: readonly FilterOption<string>[];
  onValueChange: (value: string) => void;
}) {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger render={<button id={id} type="button" disabled={disabled} aria-label={label} className={FILTER_TRIGGER_CLASS} />}>
        {face}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-(--anchor-width)">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(String(next))}>
          {options.map((option) => (
            // A pick closes the list, as a select does. Base UI radio items stay open by default.
            <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
