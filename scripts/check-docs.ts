import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Product documentation lives in a sibling repository (ADR-038). It is checked
// when it is cloned beside this one and skipped when it is not, which is the
// case in CI: this repository's own Markdown must pass on its own.
const DOCS_REPO = process.env.DOCS_REPO ?? "../adsbook.id-docs";

const failures: string[] = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

function check(file: string, heading: RegExp, rule: string): void {
  const source = readFileSync(file, "utf8");
  if (!heading.test(source) && !source.startsWith("---\n")) {
    failures.push(`${file}: must start with ${rule} or YAML frontmatter`);
  }
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0]);
    if (path && !existsSync(resolve(dirname(file), path))) {
      failures.push(`${file}: missing local link ${target}`);
    }
  }
}

// `git ls-files` still lists a file deleted in the working tree; it is not
// there to read, and its removal is the change being checked.
const own = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((file) => file && existsSync(file));
for (const file of own) check(file, /^# /, "one H1");

// A chapter split out of a larger document (`docs/contracts/tracking/`,
// `docs/product/prd/`) opens at its own section level, so `#`–`###` is accepted
// there rather than rewriting the chapters.
const docs = existsSync(join(DOCS_REPO, "docs"))
  ? [
      ...["README.md", "AGENTS.md"].filter((file) => existsSync(join(DOCS_REPO, file))),
      ...readdirSync(join(DOCS_REPO, "docs"), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".md"))
        .map((file) => join("docs", file))
        .sort(),
    ].map((file) => join(DOCS_REPO, file))
  : [];
for (const file of docs) check(file, /^#{1,3} /, "a #–### heading");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation check passed: ${own.length} Markdown files here` +
      (docs.length ? `, ${docs.length} in ${DOCS_REPO}` : ` (${DOCS_REPO} absent, skipped)`) +
      ", local links resolved.",
  );
}
