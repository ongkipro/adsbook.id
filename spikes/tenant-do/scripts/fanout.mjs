// SPIKE-1 item 1: SQL calls per page today, read from the local trace store of
// `npm run dev:local` (each D1 call is a span: d1_first/d1_all/d1_run/d1_batch).
// Usage: node scripts/fanout.mjs [base] — needs a seeded dev:local store.
const base = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const explorer = `${base}/cdn-cgi/local/explorer/api/local/observability`;
const query = async (sql) =>
  (await (await fetch(`${explorer}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }) })).json()).result;
const clear = () => fetch(`${explorer}/clear`, { method: "POST" });

const login = await fetch(`${base}/hello`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
  body: "username=admin&password=dev-local-password-123",
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const pages = [
  { name: "home", path: "/" },
  { name: "product", path: "/produk/pembersih-saluran-dummy" },
  { name: "thanks", path: "/thanks" },
  { name: "admin orders page", path: "/admin/orders", admin: true },
  { name: "admin orders API", path: "/api/admin/orders", admin: true },
  { name: "admin dashboard", path: "/admin/dashboard", admin: true },
  { name: "admin analytics API", path: "/api/admin/analytics?date_filter=custom&date_start=2026-10-17&date_end=2026-11-15", admin: true },
  { name: "admin insights trend API", path: "/api/admin/insights/trend?date_filter=custom&date_start=2026-10-17&date_end=2026-11-15", admin: true },
];

const runs = Number(process.env.RUNS || 5);
const out = [];
for (const page of pages) {
  const counts = [];
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    await clear();
    const t0 = performance.now();
    const response = await fetch(`${base}${page.path}${page.path.includes("?") ? "&" : "?"}fanout=${Date.now()}${i}`, {
      headers: page.admin ? { cookie } : {},
      redirect: "manual",
    });
    await response.arrayBuffer();
    times.push(performance.now() - t0);
    // waitUntil work (outbox, notifications) finishes after the response; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = (await query("SELECT name, COUNT(*) AS n FROM spans WHERE name LIKE 'd1_%' OR name LIKE 'cache_%' OR name LIKE 'kv_%' GROUP BY name")).rows;
    const byName = Object.fromEntries(rows.map(([name, n]) => [name, n]));
    const d1 = Object.entries(byName).filter(([name]) => name.startsWith("d1_")).reduce((sum, [, n]) => sum + n, 0);
    counts.push({ status: response.status, d1, ...byName });
  }
  const d1s = counts.map((c) => c.d1).sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  out.push({
    page: page.name,
    path: page.path,
    status: counts[0].status,
    d1_calls: { min: d1s[0], median: d1s[Math.floor(d1s.length / 2)], max: d1s.at(-1) },
    sample: counts[0],
    local_ms: { median: Math.round(times[Math.floor(times.length / 2)]), max: Math.round(times.at(-1)) },
  });
}
console.log(JSON.stringify({ base, loggedIn: Boolean(cookie), runs, pages: out }, null, 2));
