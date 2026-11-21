import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Link checks for check-docs.ts, kept apart so fixtures can run without
// touching the repository. No Markdown parser is installed, so this covers the
// forms the docs use: inline links, reference links and definitions, and
// heading anchors (GitHub slug rules). Code fences and inline code are skipped.

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Blank out fenced blocks and inline code spans, keeping line numbers stable. */
export function stripCode(source: string, keepInline = false): string {
  let fence: string | null = null;
  return source
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return "";
      }
      if (marker) {
        fence = marker;
        return "";
      }
      return keepInline ? line : line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
    })
    .join("\n");
}

/** GitHub heading slug: lowercase, drop formatting and punctuation, spaces to hyphens. */
export function slugify(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a document provides: headings (duplicates get -1, -2…) and explicit ids. */
export function anchorsOf(source: string): Set<string> {
  const anchors = new Set<string>();
  // Heading text keeps its inline code: only fenced blocks are removed here.
  const lines = stripCode(source, true).split("\n");
  const seen = new Map<string, number>();
  const add = (text: string) => {
    const slug = slugify(text);
    // GitHub: a repeat takes the next free `slug-N`, and that result is itself taken (X, X, X-1 -> x, x-1, x-1-1).
    let n = seen.get(slug) ?? 0;
    let candidate = n ? `${slug}-${n}` : slug;
    while (anchors.has(candidate)) candidate = `${slug}-${++n}`;
    seen.set(slug, n + 1);
    anchors.add(candidate);
  };
  lines.forEach((line, i) => {
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) add(atx[1]);
    else if (i > 0 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && /^ {0,3}\S/.test(lines[i - 1]) && !/^ {0,3}(?:[-*+]|\d+[.)])\s|^ {0,3}#|^ {0,3}>/.test(lines[i - 1]))
      add(lines[i - 1]);
  });
  for (const m of source.matchAll(/<a\s[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(m[1].toLowerCase());
  return anchors;
}

const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const cleanTarget = (raw: string) => raw.trim().replace(/^<([^>]*)>.*$/, "$1").split(/\s+/)[0] ?? "";

interface Ref {
  line: number;
  target: string;
  text: string;
}

/** Collect link targets (inline, reference, definition) and the problems found while resolving labels. */
function collect(source: string): { refs: Ref[]; problems: string[] } {
  const lines = stripCode(source).split("\n");
  const defs = new Map<string, string>();
  const defLines = new Set<number>();
  lines.forEach((line, i) => {
    const m = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>]*>|\S*)/.exec(line);
    if (m) {
      defLines.add(i);
      if (!defs.has(normalizeLabel(m[1]))) defs.set(normalizeLabel(m[1]), m[2]);
    }
  });
  const refs: Ref[] = [];
  const problems: string[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    if (defLines.has(i)) {
      refs.push({ line: n, target: cleanTarget(defs.get(normalizeLabel(/\[((?:[^\]\\]|\\.)+)\]:/.exec(line)![1]))!), text: "definition" });
      return;
    }
    const rest = line
      .replace(/!?\[[^\]]*\]\(((?:[^()\s]|\([^)]*\))*(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*|<[^>]*>[^)]*)\)/g, (_all, dest: string) => {
        refs.push({ line: n, target: cleanTarget(dest), text: "inline" });
        return " ";
      })
      .replace(/!?\[((?:[^\]\\]|\\.)*)\]\[((?:[^\]\\]|\\.)*)\]/g, (_all, text: string, label: string) => {
        const key = normalizeLabel(label || text);
        const dest = defs.get(key);
        // lazy: `[a][b]` is literal text in CommonMark when `b` is undefined, and one frozen
        // audit uses that form on purpose. Flag it only in a document that defines labels
        // (so reference links are in use); upgrade path: a real parser.
        if (dest === undefined) {
          if (defs.size) problems.push(`line ${n}: undefined reference label [${label || text}]`);
        } else refs.push({ line: n, target: cleanTarget(dest), text: "reference" });
        return " ";
      });
    // Shortcut form `[label]` counts only when a definition exists; otherwise it is plain text.
    for (const m of rest.matchAll(/(?<![\]\\!])\[((?:[^\]\\]|\\.)+)\](?![[(:])/g)) {
      const dest = defs.get(normalizeLabel(m[1]));
      if (dest !== undefined) refs.push({ line: n, target: cleanTarget(dest), text: "shortcut" });
    }
  });
  return { refs, problems };
}

/** A heading anchor, or a GitHub line anchor (`#L12`, `#L12-L30`) that lies inside the file. */
function hasAnchor(source: string, anchor: string): boolean {
  const lines = /^l(\d+)(?:-l(\d+))?$/.exec(anchor);
  if (lines) {
    const total = source.replace(/\n$/, "").split("\n").length;
    return Math.max(Number(lines[1]), Number(lines[2] ?? 0)) <= total;
  }
  return anchorsOf(source).has(anchor);
}

/** Problems in one document's links. `read` returns another document's source, or null when absent. */
export function linkProblems(
  file: string,
  source: string,
  read: (path: string) => string | null = (p) => (!existsSync(p) ? null : statSync(p).isDirectory() ? "" : readFileSync(p, "utf8")),
): string[] {
  const { refs, problems: labelProblems } = collect(source);
  const failures = labelProblems.map((p) => `${file}: ${p}`);
  for (const { line, target } of refs) {
    if (!target || EXTERNAL.test(target)) continue;
    const hash = target.indexOf("#");
    const rawPath = hash === -1 ? target : target.slice(0, hash);
    const rawAnchor = hash === -1 ? "" : target.slice(hash + 1);
    let path: string;
    let anchor: string;
    try {
      path = decodeURIComponent(rawPath);
      anchor = decodeURIComponent(rawAnchor).toLowerCase();
    } catch {
      failures.push(`${file}:${line}: malformed link ${target}`);
      continue;
    }
    if (!path) {
      if (anchor && !hasAnchor(source, anchor)) failures.push(`${file}:${line}: missing anchor ${target}`);
      continue;
    }
    const resolved = resolve(dirname(file), path);
    const other = read(resolved);
    if (other === null) {
      failures.push(`${file}:${line}: missing local link ${target}`);
    } else if (anchor && /\.md$/i.test(path) && !hasAnchor(other, anchor)) {
      failures.push(`${file}:${line}: missing anchor ${target}`);
    }
  }
  return failures;
}
