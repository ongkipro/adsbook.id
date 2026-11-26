# AGENTS.md — Working Agreement for adsbook.id

> Verified against disk: 2026-11-26 @ `8e35715` (§4 baseline 1764, schema 90, 203 routes; only an exact Mengantar return status (`RTS`, `RETURNED`, `RETURN_TO_SENDER`) maps to `returned`, both status mappers pinned to the same answer; PR #106). Previously: 2026-11-26 @ `9fd1950` (§4 baseline 1763, schema 90, 203 routes; identity registry sync fenced to live tenant states with explicit `reconcileFencedTenantIdentities` for `recovery`, receiver-score backfill skipped on paused stores, non-string Mengantar status tolerated, AN-1 figures made disjoint; PR #104–#105). Previously: 2026-11-26 @ `b3d5214` (§4 baseline 1759, schema 90, 203 routes; Mengantar v2 plain-string status parser fix verified against sandbox, fixed demo hardening + live `is_demo = 1` showcase, AN-1 `delivered_cod_revenue` + AN-2 first-contact clarity, admin sticky/settings/docs UX polish; PR #103). Previously: 2026-11-25 @ `aefdb86` (§4 baseline 1758, schema 90, 203 routes; Mengantar webhook Phase 2 + Base URL UI cleanup + sticky profile rail fix, unified `/feed/catalog.xml` + `/admin/ads/google` CLS fix; PR #101–#102). Previously: 2026-11-25 @ `ed76acb` (§4 baseline 1754, schema 89; /admin/profile polish, per-order external shipping channel, hourly Mengantar reconcile, analytics/routing clarity, dispatch audit; PR #96–#100). Previously: 2026-11-24 @ `f539e6e` (§6 one headless UI library, PR #81). Previously: 2026-11-19 @ `b7d73a0` (§4 baseline 1588, browser 28/28; platform SEO and noindex shields, PR #37). Previously: 2026-11-19 @ `1c09e9e` (§4 baseline 1578, browser 28/28; bank account or AutoLaris required where COD skips a province, PR #36). Previously: 2026-11-19 @ `a52a91f` (§4 baseline 1577, browser 27/27; one sign-in door at adsbook.id/masuk, control plane v11, PR #35). Previously: 2026-11-18 @ `1e3e97d` (§4 baseline 1574, browser 24/24; instant cache bump, digital products, schema 85, PR #34). Previously: 2026-11-18 @ `d0b4042` (§4 baseline 1551, browser 23/23; phone header and menu, PR #33). Previously: 2026-11-18 @ `e5dfa37` (§4 baseline 1551, browser 22/22; Google Data Manager API, PR #32). Previously: 2026-11-18 @ `e6b4352` (§4 baseline 1539, browser 20/20; borderless gallery, PR #31). Previously: 2026-11-18 @ `b7d13f3` (§4 baseline 1538, browser 19/19; TikTok Pixel + Events API, PR #30; §2 TRACKING_SPECS row names chapter 11). Previously: 2026-11-18 @ `79ec7a4` (§4 baseline 1513, browser 18/18; white gallery UI, PR #29). Previously: 2026-11-18 @ `d97c160` (§4 baseline 1512, browser 18/18; unified SiteHeader + HybridGeoSim + Bento + head-to-head compare, PR #28). Previously: 2026-11-18 @ `7958220` (§4 baseline 1512, browser 16/16; PR #27). Previously: 2026-11-18 @ `12ae288` (§4 baseline 1511, browser 18/18; Indonesian form validation, PR #26). Previously: 2026-11-18 @ `eae0723` (§4 baseline 1505, browser 14/14; home 3D hero, PR #25). Previously: 2026-11-18 @ `e108c46` (§4 baseline 1502; daily PLATFORM_DB backup to R2, PR #24). Previously: 2026-11-18 @ `b603660` (§4 baseline 1496; shared kecamatan cache + WhatsApp redirect switch). Previously: 2026-11-18 @ `4fd9d2f` (§4 baseline 1493; store logo upload PR #21). Previously: 2026-11-17 @ `9245b33` (§4 baseline 1487; default blue accent & logo replacement PR #18–#20). Previously: 2026-11-17 @ `a201200` (§4 baseline 1484; blue wordmark and /coba PR #17). Previously: 2026-11-17 @ `2754c1b` (§4 baseline 1483, browser 13/13; admin stability PR #15–#16). Previously: 2026-11-17 @ `c81c607` (§4 baseline 1475; owner preview PR #14). Previously: 2026-11-17 @ `50bc691` (adsbook.id 1.0.0; §4 baseline 1473, browser 12/12; PR #13). Previously: 2026-11-17 @ `4c60257` (§2 AUTOLARIS_INTEGRATION_SPEC added; §4 baseline 1471, browser 12/12; PR #12). Previously: 2026-11-17 @ `c08d9d3` (§4 baseline 1470; console audit PR #11). Previously: 2026-11-17 @ `f8954b8` (§4 baseline 1468, browser 10/10; console UI PR #10). Previously: 2026-11-16 @ `9e7dfb7` (§4 baseline 1458, browser 9/9; platform console PR #9). Previously: 2026-11-16 @ `4bfb04e` (§4 baseline 1451, browser 8/8; register flow PR #8). Previously: 2026-11-16 @ `bbf039b` (platform live: billing ADR-041, seller zone `adsbook.my.id`; §3 config and subscription invariants, §4 baseline 1448, §2 direction). Previously: 2026-11-16 @ `81ed0b2` + T-29 tree (product named adsbook.id). Previously: 2026-11-16 @ `5ff5f3f` (§2 ownership table: `docs/operations/PLATFORM-RUNBOOK.md` added, T-39). Previously: 2026-11-16 @ `96fdd8a` (§4 baseline 1227 re-run on `release/1.10.1`, 1.10.1). Previously: 2026-11-16 @ `18d0a4a` (§2 skill path and spec checker command aligned with `adsbook.id-docs`). Previously: 2026-11-14 @ `2b244be` (§2 ownership table: spec pack `docs/spec/` added, `docs/product/PRD.md` re-scoped to the inherited base). Previously: 2026-11-13 @ `1403298` (§2 ownership table re-pointed to the adsbook.id-docs repository, ADR-038; §4 baseline 1207 re-run). Previously: 2026-11-10 @ `745de51` (1.10.0; §4 baseline 1207 re-run on that tree). Previously: 2026-11-06 @ `700bc21` + fix/image-guard-parser working tree (1.9.2; §4 baseline 1193 re-run on that tree; the lib-module count, the auth test count and the §6 guard names re-checked; other claims not re-audited)

This file is the contract for any AI coding agent or contributor working in this repository. Read it before the first edit.

**The product is adsbook.id**, built from the single-tenant AdsBookCMS base, where **1 installer = 1 Worker = 1 store** held for the base. Since 2026-11-16 `main` is the multi-tenant platform (ADR-039): one Worker `adsbook-platform` for every store, live on `adsbook.id`, `app.adsbook.id` and the seller zone `adsbook.my.id`. `permatamall.shop` is the reference instance, not the product name.

---

## 1. First principles

1. **The code wins.** When documentation and the tree disagree, the tree is right and the document is a bug to be fixed. This repository was forked from an upstream engine and its documentation described that other repository for months; assume nothing you have not verified.
2. **Never claim something works without running it.** `npm test`, `npm run check`, `npm run build`. For anything browser-visible, open the page — an unterminated `.astro` frontmatter block once produced a live 404 while every static check stayed green.
3. **State what you did not do.** Skipped verification, deferred scope, and unproven assumptions get named explicitly.
4. **This repository deploys nothing.** It is the product; CI runs check, test and build only. A live store deploys from its own install repository, against its own resources. Never add a deploy step or Cloudflare credentials here.

---

## 2. Document ownership

Exactly one document owns each subject. Do not restate another document's truth; link to it.

Product documentation lives in a separate repository, **adsbook.id-docs**, cloned beside this one (`../adsbook.id-docs/`, i.e. `~/Projects/adsbook.id-docs/`; ADR-038). Paths below starting with `docs/` are relative to that repository's root; `README.md`, `AGENTS.md` and `doc/` are in this repository. Never create `PRD.md`, `TASKS.md`, `STATUS.md`, `DECISIONS.md`, `PLAN.md` or another product document here: extend its owner in `../adsbook.id-docs/docs/` (index: `../adsbook.id-docs/README.md`). `src/**/README.md` files outside `src/pages/` are local boundary notes, subordinate to the document they name. This project is new: never commit, push or add a remote toward `ongkipro/adsbookcms`, and never touch a store of the old fleet. **Direction:** adsbook.id is becoming a multi-tenant SaaS (canonical requirements `docs/spec/02-PRD.md`, ADR-039 Option D accepted, design `docs/architecture/MULTI-TENANT-DESIGN.md`: one Worker, one SQLite Durable Object per tenant in APAC, Cloudflare for SaaS; see the `cloudflare-for-saas` skill (`~/dotfiles/skills/local/cloudflare-for-saas/`)). The platform tasks have landed (live 2026-11-16): the invariants below describe the code as it runs per tenant, and any change that adds tenant routing, a tenant database handle or shared-resource keys follows ADR-039 and needs its cross-tenant test.

| Document | Owns |
| --- | --- |
| `README.md` | Repository entry point and orientation. Owns nothing else — it links |
| `AGENTS.md` | Working rules for anyone editing this repository, including this table |
| `docs/architecture/ARCHITECTURE.md` | System structure, data layer, config resolution, gap register §10 |
| `docs/architecture/MULTI-TENANT-DESIGN.md` | How adsbook.id becomes multi-tenant (ADR-039): request path, domains, control plane, `TenantStore` Durable Object adapter, migrations, shared resources, sessions, webhooks, housekeeping, custom hostnames, operations |
| `docs/architecture/DECISIONS.md` | The one decision index (ADR-001…), status per decision; full text in `adr/`. Append-only |
| `docs/operations/RELEASE.md` | Single-tenant deploy, migrations, versioning, rollback, approval boundary (scope note: the old fleet; the platform runbook comes with T-30; the platform delivery contract is `docs/spec/15-DEVOPS-CICD-MIGRATIONS.md`) |
| `docs/architecture/OBSERVABILITY.md` | Logging, failure visibility, what to enable |
| `docs/operations/PLATFORM-RUNBOOK.md` | Multi-tenant operating procedures: buyer requests (PRIV-5) and incidents/breaches (SEC-7 → PRIV-6) from T-39; deploy, migration, restore and daily operations from T-30 |
| `docs/operations/INSTALLATION.md` | Standing up a new install |
| `docs/operations/STATUS.md` | Current state: Now / Next / Blockers, under 12 KB. History up to 2026-11-10 is frozen in `docs/archive/STATUS-2026-11-10.md` |
| `docs/operations/FLEET.md` | The install fleet: which stores run AdsBookCMS, their version, repository, visibility, infrastructure and per-install merge rules |
| `docs/product/UNIMPLEMENTED_SPECS.md` | Remaining work and external blockers |
| `docs/spec/02-PRD.md` | **adsbook.id product requirements** (`PR-*`, `NFR-*`, open questions). The canonical PRD from 2026-11-14 |
| `docs/spec/03-…17-*.md`, `docs/spec/CONTEXT-RECORD.md` | Spec pack (development-spec-suite): one namespace each — `TD-*` design, `ARCH-*` architecture, `DATA-*` data, `TEN-*` isolation, `IAM-*` identity, `DOM-*` domains, `API-*` APIs, `UI-*` white-label, `BILL-*` billing, `SEC-*` security, `PRIV-*` privacy, `DEL-*`/`MIG-*` delivery, `OBS-*` observability, `UX-*` screens; context `CTX-*`/`JUR-*`/`XFER-*`. Index `docs/spec/README.md`; check `scripts/check-spec.sh` in the docs repository |
| `docs/product/PRD.md` | Inherited single-tenant base-product requirements (`REQ-*`, chapters A0–A47) that every tenant store runs. Chapters A48/A49 are frozen (moved to `docs/spec/02-PRD.md`) |
| `docs/product/TASKS.md` + `docs/product/tasks/P*.md` | The one execution queue (`T-*`, each with one primary `PR-*`): phase 1 contracts and the index in `TASKS.md`, phases 2–4 in the phase files; each file under 50 KB. Finished contracts are frozen in `docs/archive/TASKS-<date>.md`. Check: `scripts/check-spec.sh` in the docs repository |
| `docs/product/TASKS-LEGACY-INDEX.md` | Untriaged open rows inherited from the AdsBookCMS ledger |
| `docs/history/BUILD-LOG.md` | Chronological history. Append-only |
| `docs/design/DESIGN-SYSTEM.md` | Visual contract |
| `docs/contracts/STOREFRONT_INTEGRATION.md` | Headless `/api/v1/*` contract |
| `docs/contracts/OPS-API.md` | Operations `/api/ops/v1/*` contract: scopes, operations, errors. The OpenAPI document it names is generated from `src/lib/ops-openapi.ts` |
| `docs/contracts/MENGANTAR_INTEGRATION_SPEC.md` | Courier provider boundary |
| `docs/contracts/AUTOLARIS_INTEGRATION_SPEC.md` | Payment gateway boundary: the payment-only `/submit` profile (`courir_id: 1`, default area pair) and what a seller fills in (the API key) |
| `docs/contracts/TRACKING_SPECS.md` | Ad signal contract; chapter `docs/contracts/tracking/10-google-ads.md` holds its §10, chapter `docs/contracts/tracking/11-tiktok-and-google-deep-tracking.md` the TikTok contract (§6) and the Google Phase 2 blueprint |
| `docs/operations/TRACKING_RUNBOOK.md` | Live tracking checks and dated fleet audits (TRACKING_SPECS §16.1–§16.3). Subordinate to TRACKING_SPECS |
| `docs/product/PRD-ADMIN-LOGIN.md` | Admin login, first-run access, session |
| `docs/operations/GOOGLE_ADS_SETUP.md` | Google Ads / Merchant Center setup |
| `docs/design/LANDING-PAGES.md` | Building a landing page, CMS or native Astro |
| `doc/ROUTE-MAP.md` / `doc/route-map.xml` | **Generated, never edited.** The route and module dictionary: URL → file → verbs → auth → roles → libs → tables → tests, and each `src/lib` module's exports, tables, test and callers. `npm run route-map` writes it; `src/lib/route-map.test.ts` fails when it and the filesystem disagree. The first thing to open for an audit, and the thing `docs/architecture/ARCHITECTURE.md` §3 defers to for counts |
| `docs/operations/UPDATE-PATH-OWNERSHIP.md` | Which paths an install update copies and which it never touches (ADR-020). `docs/operations/RELEASE.md` §7 owns the procedure that uses it |
| `docs/architecture/adr/ADR-NNN-*.md` | One file per decision, full text. Indexed and status-owned by `docs/architecture/DECISIONS.md` |
| `docs/product/prd/*.md` | Base-product PRD chapters (one per epic), indexed from `docs/product/PRD.md`; A48/A49 frozen |
| `docs/archive/BUILD-LOG-*.md` | Frozen BUILD-LOG volumes, indexed at the top of `docs/history/BUILD-LOG.md` |
| `docs/design/design-tokens.md` | Neutral colour/type/spacing values. Subordinate to `docs/design/DESIGN-SYSTEM.md`, which wins on conflict |
| `docs/design/NATIVE_LANDING_PAGE_SPEC.md` | Implementation standard for a native Astro landing page. Subordinate to `docs/design/LANDING-PAGES.md` |
| `docs/archive/*` | Frozen history moved out of hot files. Never edited; IDs in it keep resolving |
| `docs/audits/AUDIT-<date>.md`, `docs/audits/REVIEW-<date>.md` | Point-in-time audit report. Findings only; every fix is owned by the document or issue it names. Never a source of truth, never maintained after its date |

Every document carries a `> Verified against disk: <date> @ <sha>` line, this one
included. If you change what a document describes, update that line or the
document is lying about its own freshness. A rewritten history orphans every SHA
those headers cite, so re-stamp them all when `main` is re-founded — sixteen
documents were left pointing at commits reachable only from
`backup/pre-history-rewrite`.

**This table is the only copy.** `README.md` links to it rather than repeating
it; the two drifted apart the last time both carried a list, which is the exact
failure mode this section exists to prevent.

---

## 3. Invariants — do not break these

**Commerce**
- Checkout never dispatches to a courier. Orders land as `pending`; an operator releases them explicitly from `/admin/orders`.
- Paid status changes dispatch *eligibility*, never dispatch itself.
- Price, stock, weight, and identity come from D1. Browser state is never pricing authority.
- **Subscription gates a store's money paths (ADR-041, `src/platform/billing.ts`).** A store in Preview Mode (no `subscription_ends_at`) or past its 48-hour grace takes no buyer order, no anonymous shipping quote, no custom-domain claim and no AI draft (402 `SUBSCRIPTION_REQUIRED` / `_EXPIRED`), sends no ad signal (`getStoreAdsConfig` is empty on every request, the tenant alarm skips the CAPI and Google drains), and is `noindex`; `/hello`, `/admin` and `/admin/billing` always stay open. Days are credited once, only on an explicit AutoLaris Advice settlement or an audited `platform_owner` grant; billing uses only `PLATFORM_AUTOLARIS_*`, never a tenant's AutoLaris key. The demo store (PR-26) is exempt. The gate reads Astro's normalised `context.url`.
- **Stock never gates a sale (ADR-023).** It is not read at checkout, at CS conversion, or when deciding what the storefront publishes, and nothing decrements or restores it. Do not reintroduce a stock check; the tests assert its absence.
- Exactly-once order release is enforced through the shared order lifecycle. All single/bulk status changes and deletions must use `src/lib/order-lifecycle.ts`; never write order status or delete order rows around it. `orders.stock_restored_at` is that marker — it predates ADR-023 and now means only "this order is void".
- Anonymous storefront HTML may be served from a two-minute edge cache (ADR-029, `src/lib/edge-cache.ts`). A page whose HTML differs per visitor must not be cacheable: set `Cache-Control: no-store`, set a cookie, or add its path to the denylist. Never write a per-visitor value (an event id, a token, a geo result) into server-rendered HTML.
- Optional integrations are first-party plugins under `src/plugins/<id>/` (ADR-028; Kelola is the first). The core reaches them only through `src/plugins/registry.ts` (`scheduleOrderCreated`, `runPluginCron`). A plugin's tables (`plugin_<id>_*`) are created by its own schema steps on activation, never by `src/db/migrations`. Until a store activates a plugin, it has no row, table, menu, or hook call for it. An install never deletes plugin code to opt out (ADR-027).

**Config**
- Binding names are fixed: `OMS_DB`, `SESSION`, `ASSET_BUCKET`, `AI`, `ASSETS`.
- Provider credentials are D1-first, env-fallback. Never echo a stored credential back through a browser API.
- The admin session key is read only through `resolveAuthSecret` (`src/lib/auth-secret.ts`): an `AUTH_SECRET` env secret of 32+ characters wins, otherwise the Worker's own key from `install_secrets` (ADR-026). Never read `install_secrets` anywhere else, and never return it.
- `wrangler.jsonc` is the platform Worker's production configuration (T-30): the real `adsbook-platform*` D1, KV and R2 ids, the `*/*` route on `adsbook.my.id`, Custom Domains for `adsbook.id` and `app.adsbook.id`, and only two public vars (`CF_SAAS_ZONE_ID`, `TURNSTILE_SITE_KEY`; `gate.test.ts` pins them). Every secret goes through `wrangler secret`, never here. There is no one-click install and no `INSTALL_TOKEN`.
- Meta CAPI tokens are server-only. Browser and server Purchase share one per-order `event_id`.
- **Every path that creates a Purchase-qualifying order sends it from the server (ADR-036).** COD checkout (`submit-order`, `submit-middle-order`, `/api/v1/checkout`) and a CS lead conversion call `scheduleCodPurchase`; a payment becoming paid (AutoLaris reconciliation, "Transfer Diterima") calls `enqueuePurchaseForPaidOrder`. `/thanks` is the browser leg, never the only leg: a buyer who never reaches it used to be a sale Meta never saw. A new order path without one of these is a defect; `meta-purchase-coverage` alerts on it.
- **A lead is deleted only by the 14-day retention purge (ADR-035).** `deleteOrdersReleasingReservations` refuses an `abandoned` row; a source scan allows exactly two `DELETE FROM orders` (the lifecycle and the purge).
- **One `fbq('init')` per pixel id, and `MetaPixelBase` owns it.** fbevents honours advanced matching exactly once per pixel id and discards every later call in silence — not an error, not a warning. Three files once init'd behind the pixel's bootstrap, so the browser Purchase reached Meta matched on one key while the server leg matched on eight. A page with better matching supplies it through `window.__PS_META_INIT__` and declares `__PS_META_AWAIT_MATCHING__` ahead of the pixel; nothing else calls `fbq('init')`. Tests assert this at both source and runtime (TRACKING_SPECS §4a), including that the bootstrap still exposes `__PS_META_INIT__` and `__PS_LOAD_META_PIXEL__` — their callers use `?.`, so a bootstrap without them drops matching in silence. Every browser `track` goes through `window.__PS_META_TRACK__`, which holds it until that init is issued; fbevents discards a track replayed ahead of the init.
- **The catalogue identity fails closed for an ads payload and degrades everywhere else.** `catalogProductId` throws on a row that predates the five-digit scheme, which is right for one payload and wrong wherever the throw outlives the row — a feed, a list, a `.find` predicate, a React render. Those read `catalogProductIdOrNull`. An allowlist test in `catalog-identity.test.ts` refuses a new strict call site.
- Every Headless route is registered in `HEADLESS_OPERATIONS` with one minimum scope. API-key usage quotas and write audit events are D1-backed and part of the request boundary, not UI-only policy.

**Content**
- Product presentation does **not** fail closed, and that is deliberate: an active product with no published content still renders, described from its own title, category and variants. What must never happen is copy belonging to a different product or a different merchant reaching it — that is the invariant, not omission.
- No merchant's content, brand, contact details, or media may ship for a different merchant. This has gone wrong before and reached production.

**Data**
- `src/db/migrations/` is the only description of the schema. There is no `schema.ts` and no generator.
- Migrations are hand-authored.
- Never edit an applied migration in place. Corrections are new forward migrations. The single documented exception is `0017`, which had to be edited because it aborted the chain on a fresh database — read its header before considering another.
- The Worker applies the checked-in migration chain on the first database-backed request after a deploy. Claim rows in `d1_migrations` and their schema statements run in one D1 batch; do not split that atomic boundary.

---

## 4. Verification

```bash
npm test          # node --test over src/lib and src/plugins tests
npm run check     # astro check && tsc --noEmit
npm run build     # astro build
npm run route-map # after adding, moving or deleting a page or a lib module
```

`npm test` includes the route-map drift check: add a page under `src/pages/`
or a module under `src/lib/` without regenerating and the suite fails naming
what changed. That is deliberate — a map you must remember to update is a map
that lies, and the previous prose map in `docs/architecture/ARCHITECTURE.md` §3 did.

A React island is only partly covered. A component that throws during SSR
answers `200` with an **empty body** — a blank white page that every static
check calls healthy; 1.3.4 shipped a one-line island change to every install and
left the admin order list blank for a day. `src/lib/admin-islands-render.test.ts`
now bundles and server-renders the seven admin islands that carry data
(`OrdersTable`, `OrderDetail`, `PaymentReconciliationQueue`, `ProductForm`,
`LandingPageEditor`, `RateCheckTools`, `OperationalStatus`); any other island, and every client-side script, is still
proven only by opening the page. Put branch logic in `src/lib/` where the runner
can reach it.

On a fresh clone, run `npm run check` rather than bare `npx tsc --noEmit`. `astro check` generates `.astro/types.d.ts` first; without it `tsc` reports phantom errors such as `Property 'env' does not exist on type 'ImportMeta'`.

Current verified baseline: **1764 passing** (0 skipped, 2026-11-26, `main` @ `8e35715`; GitHub CI full 121-test Playwright suite green on `main`), 0 type errors, `astro check` 0 errors / 0 warnings / 0 hints. A change that reduces this baseline is not done.

New non-trivial logic — a branch, a parser, a money or auth path — leaves one runnable check behind. Trivial one-liners do not need a test.

`src/lib/auth.ts` is covered by `src/lib/auth.test.ts` (17 tests; mutation-verified when it had 15). That suite asserts security *properties* — a tampered signature is rejected, a rotated credential closes the session, a role never reaches a route it should not. Keep it that way: a test that merely asserts a valid token is valid buys nothing.

---

## 5. Approval gates

Ask before: `wrangler deploy` or any `--remote` D1 command — both act on a real install and neither belongs to this repository; creating or deleting Cloudflare resources; anything that mutates provider state at Mengantar or AutoLaris; reading or printing secrets; deleting data; pushing to a branch that an install deploys from.

Pushing to `main` **here** deploys nothing (ADR-012), so it is ordinary work — but adding a deploy step or Cloudflare credentials to this repository is not, and must never be done.

Local work — tests, typecheck, build, local D1, reading code — needs no approval.

A permitted command is not an approved one. The tooling here runs with broad permissions; the boundary is behavioural.

---

## 6. Code discipline

Smallest change that is correct. Reuse what exists before adding; the codebase already has 140 non-test lib modules and duplicating one is the most common failure mode.

Before adding a dependency, check whether the platform already provides it. The UI uses one headless library, `@base-ui/react` (shadcn `base-nova`); `ui-primitive-library.test.ts` fails if Radix or another one comes back. Add components with `shadcn add`, never by pasting a file from another style.

Admin UI follows the control contract in `docs/design/DESIGN-SYSTEM.md` §7.1: shadcn
primitives own every control's height, radius and colour (never pass them per
call), filter rows are `FilterBar`/`FilterField`, search is `SearchInput`, page
width belongs to AdminShell alone. `admin-controls.test.ts` and
`admin-page-width.test.ts` fail the suite when a screen drifts from it — fix
the screen, not the test. `docs/design/DESIGN-SYSTEM.md` §0 is the whole UI contract in one
page, including the public image rule that `storefront-images.test.ts` guards;
read it before touching a component, and before taking the look to another project.

Fix root causes, not symptoms. Grep every caller before editing a shared function: one guard in the shared path is a smaller diff than one guard per call site, and patching only the path in front of you leaves siblings broken.

Deliberate corner-cuts get a `// lazy:` comment naming the ceiling and the upgrade path.

---

## 7. Things that are wrong on purpose right now

Do not "fix" these silently or treat them as bugs to be surprised by — they are known, tracked, and have decisions attached:

- Missing published home content is composed from the store's **own** name, catalogue and public landing pages (ADR-025 amending ADR-007). Never restore compiled copy or anything written for another merchant.
- Storefront template definitions live in `storefront_templates`. Built-in `compact-market` is seeded only as an editable D1 definition (`wide-catalog` was removed by `0044`); adding a definition must not require a rebuild.
- The admin session cookie is `__Host-adsbook_session` (IAM-2, T-22), declared once as `SESSION_COOKIE_NAME` in `src/lib/auth.ts`, and every set **and delete** spreads `SESSION_COOKIE_OPTIONS` (`Secure; Path=/`, no `Domain`): a `__Host-` delete without `Secure` is ignored by the browser. Never write the literal string; a writer and reader that disagree is a silent lockout.
- The `SESSION` KV binding holds **caches only** (ADR-021). Admin sessions live in `admin_sessions` and rate-limit windows in `rate_limits`, both D1. A KV write on any request path must be wrapped so that its failure is logged and nothing else — the account-wide Free-plan write allowance ran out once and took every install's login and checkout search down with it.
- The click cookie is `adsbook_click_ids`. The former `zanoby_click_ids` is still **read** as a fallback so an upgrading install does not lose 90 days of in-flight attribution. Never write the legacy name; it ages out on its own.
- Newly issued developer API keys carry `adsbook_live_`. Keys issued as `cmsads_live_` still validate — the stored value is a SHA-256 digest, so the prefix never took part in matching, and rewriting it would have broken them. The legacy prefix survives only in `maskApiKeySecret` so an old key still renders a coherent preview.

---

## 8. Language

Repository artifacts — documentation, code comments, commit messages — are written in **English**. User-facing product copy is Indonesian. Do not translate quoted UI strings or third-party interface labels.
