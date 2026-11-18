/**
 * robots.txt bodies (RFC 9309), shared by the store and platform hosts.
 *
 * A crawler obeys only its most specific matching group: once the file holds
 * a `User-agent: Googlebot` group, Googlebot ignores `User-agent: *`. So each
 * named agent carries its own copy of the disallow list, or a Cloudflare
 * managed group for the same agent would leave it with nothing disallowed.
 *
 * Search engines and AI *answer* agents (live retrieval for a user's question)
 * are named: a page sells by being found, and an assistant can cite only what
 * it may read. AI *training* crawlers are deliberately not named: the managed
 * robots.txt prepends a `Disallow: /` group for each, and a second group here
 * saying `Allow: /` made the file contradict itself.
 *
 * A `noindex` page is never disallowed here: a blocked URL hides its own
 * `noindex` and can still be indexed without a snippet.
 */
export const ROBOTS_NAMED_AGENTS = [
  "Googlebot",
  "Googlebot-Image",
  "Bingbot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
] as const;

export function robotsTxt(disallow: readonly string[], sitemap?: string | null): string {
  const group = (agent: string) => [`User-agent: ${agent}`, "Allow: /", ...disallow.map((path) => `Disallow: ${path}`)].join("\n");
  return [group("*"), ...ROBOTS_NAMED_AGENTS.map(group), ...(sitemap ? [`Sitemap: ${sitemap}`] : []), ""].join("\n\n");
}

/** A host no crawler should read at all (the operator console). */
export const ROBOTS_DISALLOW_ALL = "User-agent: *\nDisallow: /\n";
