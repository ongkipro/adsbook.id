// Open-loop load: RPS requests per second for SECONDS against one path.
// Usage: node scripts/load.mjs <url> [rps=50] [seconds=60]
const [url, rpsArg, secondsArg] = process.argv.slice(2);
const rps = Number(rpsArg || 50);
const seconds = Number(secondsArg || 60);
const samples = [];
const statuses = {};
let errors = 0;
const started = Date.now();
const inflight = [];
for (let i = 0; i < rps * seconds; i += 1) {
  const wait = started + (i * 1000) / rps - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const t0 = performance.now();
  inflight.push(
    fetch(url, { method: "POST" })
      .then(async (response) => {
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        if (response.status !== 200) errors += 1;
        samples.push(performance.now() - t0);
      })
      .catch(() => {
        errors += 1;
      }),
  );
}
await Promise.all(inflight);
samples.sort((x, y) => x - y);
const at = (q) => Math.round(samples[Math.floor(q * (samples.length - 1))] * 100) / 100;
console.log(JSON.stringify({ url, rps, seconds, requests: rps * seconds, errors, statuses, wallSeconds: (Date.now() - started) / 1000, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }));
