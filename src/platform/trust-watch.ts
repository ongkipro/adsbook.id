/**
 * Indonesian ISPs drop traffic to every IP on Komdigi's Trust+ IP list. A
 * Cloudflare IP is shared by many sites, so one blocked neighbour takes the
 * platform's hosts offline for every Indonesian buyer while the rest of the
 * world still reaches them — `adsbook.cc`'s first IP pair was on the list on
 * 2026-11-16 (PLATFORM-RUNBOOK §6). Once a day the platform cron resolves its
 * own hosts and checks their IPs against the published list; a listed IP is
 * logged on every run and sent to the operator once a day.
 */
import { PRODUCTION_PLATFORM_HOSTS } from "./host.ts";
import { SELLER_ZONE, tenantHostSuffix } from "./hostnames.ts";
import { notifyPlatform } from "./notify.ts";

export const TRUST_POSITIF_IP_LIST = "https://trustpositif.komdigi.go.id/assets/db/ipaddress_isp";
const DOH = "https://cloudflare-dns.com/dns-query";

/** The hosts whose IPs Indonesian buyers and sellers must reach. */
export function watchedHosts(env: Record<string, unknown>): string[] {
  const suffix = tenantHostSuffix(env);
  // A local stand-in suffix (dev) has nothing public to check.
  const seller = suffix === SELLER_ZONE ? [suffix, `cname.${suffix}`] : [];
  return [...PRODUCTION_PLATFORM_HOSTS, ...seller];
}

// lazy: IPv4 only — the Trust+ list is IPv4; add AAAA if it starts listing IPv6.
async function resolveA(host: string, fetcher: typeof fetch): Promise<string[]> {
  const response = await fetcher(`${DOH}?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? []).filter((answer) => answer.type === 1).map((answer) => answer.data.trim());
}

export type TrustWatchResult = { checked: number; blocked: { host: string; ip: string }[] };

/** Null when the list or DNS could not be read: that is not evidence of anything. */
export async function checkTrustPositif(
  env: Record<string, unknown>,
  platformDb: D1Database,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<TrustWatchResult | null> {
  try {
    const ipsByHost = new Map<string, string[]>();
    for (const host of watchedHosts(env)) ipsByHost.set(host, await resolveA(host, fetcher));
    const ours = new Set([...ipsByHost.values()].flat());
    if (!ours.size) return null;
    const list = await fetcher(TRUST_POSITIF_IP_LIST, { signal: AbortSignal.timeout(20_000) });
    if (!list.ok) {
      console.error("trustpositif-list-unavailable", { status: list.status });
      return null;
    }
    const listed = new Set<string>();
    for (const line of (await list.text()).split("\n")) {
      const ip = line.trim();
      if (ours.has(ip)) listed.add(ip);
    }
    const blocked = [...ipsByHost].flatMap(([host, ips]) => ips.filter((ip) => listed.has(ip)).map((ip) => ({ host, ip })));
    const day = now.toISOString().slice(0, 10);
    for (const { host, ip } of blocked) {
      console.error("trustpositif-ip-blocked", { host, ip });
      await notifyPlatform(
        env,
        platformDb,
        `trustpositif:${ip}:${day}`,
        `IP ${ip} (${host}) ada di daftar blokir Trust+ Komdigi: pengunjung dari Indonesia tidak bisa membuka host ini. Lihat PLATFORM-RUNBOOK §6.`,
        fetcher,
        now,
      );
    }
    return { checked: ours.size, blocked };
  } catch (error) {
    console.error("trustpositif-check-failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
