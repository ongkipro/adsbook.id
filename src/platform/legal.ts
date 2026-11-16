/**
 * Legal pages (T-39, PR-24): versioned platform terms and privacy notice,
 * and each store's privacy notice built from the template.
 *
 * PRIV-2: a store's notice names a provider only when the seller saved that
 * provider's credentials (or activated the plugin). The seller edits an
 * additional section of their own; the provider lines stay generated from
 * data, so an edit can never claim or hide a provider the store really uses.
 */
import { CURRENT_LEGAL_VERSION, LEGAL_TEXTS, type LegalDocId } from "./legal-texts.ts";

export { CURRENT_LEGAL_VERSION, type LegalDocId };

/** The text of a published version, or null (an unknown version is a 404, never a fallback). */
export function legalText(doc: LegalDocId, version?: string | null): { version: string; date: string; text: string } | null {
  // Only an absent version means "current": `?v=` or an unknown one is a 404.
  const id = version ?? CURRENT_LEGAL_VERSION[doc];
  const entry = Object.hasOwn(LEGAL_TEXTS[doc], id) ? LEGAL_TEXTS[doc][id] : null;
  return entry ? { version: id, ...entry } : null;
}

export function legalVersions(doc: LegalDocId): string[] {
  return Object.keys(LEGAL_TEXTS[doc]);
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The Markdown subset the drafts use — headings, paragraphs, `-` and `1.`
 * lists (with indented continuation lines), `>` notes, `|` tables, **bold**
 * and `code` —
 * to HTML. Everything is escaped first; `{placeholder}`s are filled from
 * `values` after escaping, and one left unfilled is marked, never hidden.
 */
export function renderLegalMarkdown(text: string, values: Record<string, string> = {}): string {
  const inline = (raw: string) =>
    escapeHtml(raw)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
        Object.hasOwn(values, key) ? escapeHtml(values[key]) : `<mark>${whole}</mark>`,
      );
  const html: string[] = [];
  let table: string[][] | null = null;
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let block: { tag: "p" | "blockquote"; lines: string[] } | null = null;
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const flush = () => {
    if (table) {
      const [head = [], ...body] = table.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
      const th = head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("");
      const rows = body
        .map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(head[index] ?? "")}">${inline(cell)}</td>`).join("")}</tr>`)
        .join("");
      html.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`);
      table = null;
    }
    if (block) html.push(`<${block.tag}>${inline(block.lines.join(" "))}</${block.tag}>`);
    if (list) html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    block = null;
    list = null;
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^(#{1,3}) (.+)$/);
    const bullet = line.match(/^- (.+)$/);
    const numbered = line.match(/^\d+\. (.+)$/);
    const quote = line.match(/^> ?(.*)$/);
    if (!line.trim()) flush();
    else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) flush();
      table ??= [];
      table.push(cells(line));
    } else if (heading) {
      flush();
      // The page owns <h1> (the text's own `#` title is dropped by the caller),
      // so `#`/`##` are section headings (h2) and `###` sub-sections (h3): no
      // level is skipped under the page's h1 (WCAG 1.3.1).
      const level = Math.max(2, heading[1].length);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (block || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (list && /^\s+\S/.test(line)) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else if (quote) {
      if (list || (block && block.tag !== "blockquote")) flush();
      block ??= { tag: "blockquote", lines: [] };
      block.lines.push(quote[1]);
    } else {
      if (list || (block && block.tag !== "p")) flush();
      block ??= { tag: "p", lines: [] };
      block.lines.push(line.trim());
    }
  }
  flush();
  return html.join("\n");
}

export type StoreProviders = { meta: boolean; google: boolean; mengantar: boolean; autolaris: boolean; kelola: boolean };

const PROVIDER_MARKERS: Record<string, keyof StoreProviders> = {
  Meta: "meta",
  "Google Ads": "google",
  Mengantar: "mengantar",
  AutoLaris: "autolaris",
  Kelola: "kelola",
};

/** Which providers this store has enabled, from its own data (PRIV-2). Throws if unreadable. */
export async function readStoreProviders(database: D1Database): Promise<StoreProviders> {
  const row = await database
    .prepare(
      `SELECT
         TRIM(COALESCE(meta_pixel_id, '')) <> '' OR TRIM(COALESCE(meta_capi_token, '')) <> '' AS meta,
         TRIM(COALESCE(google_ads_conversion_id, '')) <> '' OR TRIM(COALESCE(google_tag_manager_id, '')) <> ''
           OR TRIM(COALESCE(google_ads_customer_id, '')) <> '' AS google,
         TRIM(COALESCE(mengantar_api_key, '')) <> '' AS mengantar,
         -- A saved key, whatever the checkout toggle: reconciliation still talks to it.
         TRIM(COALESCE(autolaris_api_key, '')) <> '' AS autolaris,
         EXISTS (SELECT 1 FROM plugins WHERE id = 'kelola' AND enabled = 1) AS kelola
       FROM stores ORDER BY id LIMIT 1`,
    )
    .first<Record<keyof StoreProviders, number>>();
  return {
    meta: Boolean(row?.meta),
    google: Boolean(row?.google),
    mengantar: Boolean(row?.mengantar),
    autolaris: Boolean(row?.autolaris),
    kelola: Boolean(row?.kelola),
  };
}

/**
 * The store's notice as Markdown: the template's meta header dropped, every
 * `[jika X aktif]` line kept only when X is enabled, and the seller's own
 * section appended. An unknown provider marker drops its line (fail closed).
 */
export function storePrivacyMarkdown(templateText: string, providers: StoreProviders, extra: string): string {
  const start = templateText.indexOf("\n# Kebijakan Privasi");
  const body = (start >= 0 ? templateText.slice(start + 1) : templateText)
    .split("\n")
    .flatMap((line) => {
      const marker = line.match(/^- \[jika (.+?) aktif\] (.+)$/);
      if (!marker) return [line];
      const key = PROVIDER_MARKERS[marker[1]];
      return key && providers[key] ? [`- ${marker[2]}`] : [];
    })
    .join("\n");
  const own = extra.trim();
  return own ? `${body.trimEnd()}\n\n## Informasi tambahan dari toko\n\n${own}\n` : body;
}

/** The seller's own section: plain text, bounded. */
export const PRIVACY_EXTRA_MAX = 4000;
