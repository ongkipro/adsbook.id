import * as React from "react";
import { ListFilter } from "lucide-react";
import { Button } from "../ui/button";
import { FilterBar, FilterField, FilterSelect, SearchInput } from "../admin/filter-bar";

export type ConsoleSelect = { name: string; label: string; options: { value: string; label: string }[] };

/**
 * The console's filter row (T-52): the seller admin's FilterBar, FilterSelect
 * and SearchInput, with the state in the URL — Terapkan (or Enter) loads the
 * server-rendered page with the new query, Reset clears it.
 */
export function ConsoleFilters({
  selects = [],
  search,
  values,
  path,
}: {
  selects?: ConsoleSelect[];
  search?: { name: string; label: string; placeholder: string };
  values: Record<string, string>;
  path: string;
}) {
  const [state, setState] = React.useState<Record<string, string>>(values);
  const active = Object.values(values).some(Boolean);
  const apply = (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const query = new URLSearchParams(Object.entries(state).filter(([, value]) => value.trim()) as [string, string][]);
    window.location.assign(query.size ? `${path}?${query}` : path);
  };
  return (
    <form onSubmit={apply} role="search" className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <FilterBar>
        {search && (
          <FilterField label={search.label} htmlFor={`filter-${search.name}`} size="grow">
            <SearchInput
              id={`filter-${search.name}`}
              name={search.name}
              value={state[search.name] ?? ""}
              onValueChange={(value) => setState((current) => ({ ...current, [search.name]: value }))}
              placeholder={search.placeholder}
            />
          </FilterField>
        )}
        {selects.map((select) => (
          <FilterField key={select.name} label={select.label} htmlFor={`filter-${select.name}`} size="sm">
            <FilterSelect
              id={`filter-${select.name}`}
              icon={ListFilter}
              value={state[select.name] ?? ""}
              onValueChange={(value) => setState((current) => ({ ...current, [select.name]: value }))}
              options={select.options}
            />
          </FilterField>
        ))}
        <div className="flex gap-2">
          <Button type="submit">Terapkan</Button>
          {active && <Button type="button" variant="outline" onClick={() => window.location.assign(path)}>Reset</Button>}
        </div>
      </FilterBar>
    </form>
  );
}
