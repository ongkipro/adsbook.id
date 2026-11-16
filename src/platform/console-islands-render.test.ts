// T-52: every platform console island server-renders without throwing. An
// island that throws during SSR answers 200 with an empty body — a blank
// console every static check calls healthy (AGENTS.md §4). Same method as
// src/lib/admin-islands-render.test.ts: bundle with esbuild, render with
// react-dom/server.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

const require = createRequire(import.meta.url);
const TMP_DIR = path.join(process.cwd(), "node_modules", ".console-islands-render-test", `${process.pid}-${Date.now()}`);

async function renderIsland(fileName: string, exportName: string, props: Record<string, unknown>) {
  const result = await esbuild.build({
    entryPoints: [path.resolve("src/components/platform", fileName)],
    bundle: true,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    jsxImportSource: "react",
    write: false,
    external: ["react", "react-dom", "react-dom/*"],
    alias: { "@": path.resolve("src") },
    logLevel: "silent",
  });
  const outFile = path.join(TMP_DIR, `${fileName}.cjs`);
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.writeFile(outFile, result.outputFiles[0].text);
  delete require.cache[outFile];
  const mod = require(outFile);
  const Component = exportName === "default" ? mod.default : mod[exportName];
  if (typeof Component !== "function") throw new Error(`${fileName}: export "${exportName}" is not a component`);
  return renderToString(React.createElement(Component, props));
}

after(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

test("PlatformShell renders the menu, the account and the page for an owner, and hides Tim from support", async () => {
  const owner = await renderIsland("PlatformShell.tsx", "PlatformShell", {
    title: "Ringkasan",
    active: "overview",
    email: "owner@ops.test",
    role: "platform_owner",
    children: React.createElement("p", null, "isi halaman"),
  });
  assert.match(owner, /isi halaman/);
  assert.match(owner, /href="\/platform\/billing"/);
  assert.match(owner, /href="\/platform\/team"/);
  assert.match(owner, /aria-current="page"/);
  assert.match(owner, /max-w-\[1560px\]/);
  const support = await renderIsland("PlatformShell.tsx", "PlatformShell", { title: "Toko", active: "tenants", email: "cs@ops.test", role: "platform_support", children: null });
  assert.doesNotMatch(support, /href="\/platform\/team"/, "support never sees Tim");
});

test("TenantActions offers only what the status and role allow", async () => {
  const owner = await renderIsland("TenantActions.tsx", "TenantActions", { tenantId: "t1", slug: "toko-a", status: "active", allowed: ["grant-subscription", "suspend", "resume", "recover", "purge-request", "plan"], purgeScheduled: false });
  for (const label of ["Beri langganan", "Tangguhkan", "Kode pemulihan owner", "Jadwalkan penghapusan"]) assert.match(owner, new RegExp(label));
  assert.doesNotMatch(owner, /Aktifkan kembali/, "resume only for a suspended store");
  const support = await renderIsland("TenantActions.tsx", "TenantActions", { tenantId: "t1", slug: "toko-a", status: "suspended", allowed: ["suspend", "resume"], purgeScheduled: false });
  assert.match(support, /Aktifkan kembali/);
  assert.doesNotMatch(support, /Beri langganan|Jadwalkan penghapusan|Kode pemulihan/);
});

test("TeamManager lists members and never offers to disable yourself", async () => {
  const html = await renderIsland("TeamManager.tsx", "TeamManager", {
    selfId: "pu_me",
    members: [
      { id: "pu_me", email: "me@ops.test", role: "platform_owner", mfa: 1, disabled_at: null, last_sign_in: "2026-11-16T10:00:00.000Z" },
      { id: "pu_cs", email: "cs@ops.test", role: "platform_support", mfa: 1, disabled_at: "2026-11-16T11:00:00.000Z", last_sign_in: null },
    ],
  });
  assert.match(html, /me@ops\.test/);
  assert.match(html, /\(Anda\)/);
  assert.equal((html.match(/Nonaktifkan/g) ?? []).length, 0, "the only other member is already disabled");
  assert.match(html, />Aktifkan</);
});

test("ConsoleFilters, InvoiceCheckButton and DailyChart render", async () => {
  const filters = await renderIsland("ConsoleFilters.tsx", "ConsoleFilters", {
    path: "/platform/tenants",
    values: { q: "toko", status: "" },
    search: { name: "q", label: "Cari toko", placeholder: "Slug" },
    selects: [{ name: "status", label: "Status toko", options: [{ value: "", label: "Semua status" }, { value: "active", label: "Aktif" }] }],
  });
  assert.match(filters, /Cari toko/);
  assert.match(filters, /value="toko"/);
  assert.match(filters, /Reset/, "an active filter offers Reset");
  assert.match(await renderIsland("InvoiceCheckButton.tsx", "InvoiceCheckButton", { invoiceId: "inv_x" }), /Cek status/);
  await renderIsland("DailyChart.tsx", "default", { points: [{ day: "2026-11-16", signups: 2, paid: 1 }] });
});
