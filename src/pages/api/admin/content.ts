import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import {
  contentValidationMessage,
  parseContentKey,
  validateContent,
} from "../../../lib/storefront-content.ts";
import { buildContentSystemInstruction } from "../../../lib/ai-content-instructions.ts";
import { tenantDatabase } from "../../../lib/tenant-database.ts";
import { checkPlanCap } from "../../../platform/plans.ts";
import { isLive, subscriptionRefusalBody } from "../../../platform/billing.ts";

export const prerender = false;

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown content error.";

/**
 * Every write to a content row names the `version` the editor loaded
 * (`expectedVersion`), and every successful save, generate or publish bumps it.
 * 0 means "no row yet" and only ever creates one; a positive version only
 * updates the row still at that version and never recreates a missing one.
 * Without this, two editors (or a save landing while the model runs) replaced
 * each other's draft in silence, and a publish could ship a draft its author
 * never saw.
 */
class ContentVersionConflict extends Error {
  readonly currentVersion: number | null;
  constructor(currentVersion: number | null) {
    super("Konten ini sudah diubah di tempat lain. Muat versi terbaru sebelum menyimpan lagi.");
    this.currentVersion = currentVersion;
  }
}

const versionConflict = (currentVersion: number | null) =>
  json(
    {
      success: false,
      code: "CONTENT_VERSION_CONFLICT",
      currentVersion,
      error: "Konten ini sudah diubah di tempat lain. Muat versi terbaru sebelum menyimpan lagi.",
    },
    409,
  );

function readExpectedVersion(body: Record<string, unknown>): number | null {
  const value = body.expectedVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function currentVersion(database: D1Database, contentKey: string) {
  const row = await database
    .prepare("SELECT version FROM storefront_content WHERE content_key = ? LIMIT 1")
    .bind(contentKey)
    .first<{ version: number }>();
  return row ? Number(row.version) : null;
}

function databaseFrom(locals: App.Locals) {
  const database = tenantDatabase(locals);
  return database && typeof database === "object"
    ? (database as D1Database)
    : null;
}

export const GET: APIRoute = async ({ locals, url }) => {
  const database = databaseFrom(locals);
  if (!database) {
    return json({ success: false, error: "Database unavailable." }, 503);
  }
  try {
    const requestedKey = url.searchParams.get("key");
    if (requestedKey) {
      const key = parseContentKey(requestedKey);
      const record = await database
        .prepare(
          `SELECT content_key, content_type, draft_json, published_json,
            version, generated_by, updated_at, published_at
          FROM storefront_content
          WHERE content_key = ?
          LIMIT 1`,
        )
        .bind(key.key)
        .first<{
          content_key: string;
          content_type: string;
          draft_json: string | null;
          published_json: string | null;
          version: number;
          generated_by: string;
          updated_at: string;
          published_at: string | null;
        }>();
      return json({
        success: true,
        data: record
          ? {
              content_key: record.content_key,
              content_type: record.content_type,
              version: record.version,
              generated_by: record.generated_by,
              updated_at: record.updated_at,
              published_at: record.published_at,
              draft: record.draft_json ? JSON.parse(record.draft_json) : null,
              published: record.published_json
                ? JSON.parse(record.published_json)
                : null,
            }
          : null,
      });
    }

    const [store, records, products] = await database.batch([
      database.prepare(`
        SELECT CASE WHEN LENGTH(TRIM(COALESCE(ai_content_instructions, ''))) > 0 THEN 1 ELSE 0 END AS instructions_configured
        FROM stores ORDER BY id ASC LIMIT 1
      `),
      database.prepare(`
        SELECT content_key, content_type, version, generated_by, updated_at, published_at,
          CASE WHEN draft_json IS NULL THEN 0 ELSE 1 END AS has_draft,
          CASE WHEN published_json IS NULL THEN 0 ELSE 1 END AS has_published
        FROM storefront_content ORDER BY content_key ASC
      `),
      database.prepare(`
        SELECT id, title
        FROM products
        WHERE is_active = 1
        ORDER BY id ASC
      `),
    ]);
    return json({
      success: true,
      data: {
        instructionsConfigured:
          Number(
            (
              store.results?.[0] as
                | { instructions_configured?: number }
                | undefined
            )?.instructions_configured,
          ) === 1,
        canManageInstructions: locals.admin?.role === "owner",
        records: records.results ?? [],
        targets: [
          { key: "home", label: "Homepage" },
          ...(products.results ?? []).map((product) => {
            const row = product as { id: number; title: string };
            return {
              key: `product:${row.id}`,
              label: `${row.title} · Product ID ${row.id}`,
            };
          }),
        ],
      },
    });
  } catch (error) {
    return json({ success: false, error: errorMessage(error) }, 500);
  }
};

async function saveDraft(
  database: D1Database,
  keyValue: unknown,
  content: unknown,
  generatedBy: "manual" | "workers-ai",
  expectedVersion: number,
) {
  const key = parseContentKey(keyValue);
  const validated = validateContent(key.key, content);
  const now = new Date().toISOString();
  const draft = JSON.stringify(validated);
  const result =
    expectedVersion === 0
      ? await database
          .prepare(
            `
            INSERT INTO storefront_content (
              store_id, content_key, content_type, draft_json, version, generated_by, updated_at
            ) VALUES (
              (SELECT id FROM stores ORDER BY id ASC LIMIT 1), ?, ?, ?, 1, ?, ?
            )
            ON CONFLICT(content_key) DO NOTHING
          `,
          )
          .bind(key.key, key.type, draft, generatedBy, now)
          .run()
      : await database
          .prepare(
            `
            UPDATE storefront_content
            SET content_type = ?, draft_json = ?, version = version + 1,
              generated_by = ?, updated_at = ?
            WHERE content_key = ? AND version = ?
          `,
          )
          .bind(key.type, draft, generatedBy, now, key.key, expectedVersion)
          .run();
  if (!result.success) throw new Error("D1 rejected the content draft.");
  if (!result.meta.changes) {
    throw new ContentVersionConflict(await currentVersion(database, key.key));
  }
  return { key, validated, version: expectedVersion + 1 };
}

async function generationContext(database: D1Database, keyValue: unknown) {
  const key = parseContentKey(keyValue);
  if (key.type === "home") {
    const [products, variants] = await database.batch([
      database.prepare(
        `SELECT id, title, slug, category, image_url
         FROM products
         WHERE is_active = 1
         ORDER BY id ASC`,
      ),
      database.prepare(
        `SELECT pv.id, pv.product_id, pv.sku, pv.title, pv.price,
           pv.compare_price, pv.weight_grams, pv.stock
         FROM product_variants pv
         INNER JOIN products p ON p.id = pv.product_id
         WHERE p.is_active = 1
         ORDER BY pv.product_id ASC, pv.id ASC`,
      ),
    ]);
    return {
      key,
      operationalFacts: {
        products: products.results ?? [],
        variants: variants.results ?? [],
      },
    };
  }
  const product = await database
    .prepare(
      `
      SELECT id, title, slug, category, image_url, is_active
      FROM products WHERE id = ? LIMIT 1
    `,
    )
    .bind(key.productId)
    .first<Record<string, unknown>>();
  if (!product)
    throw new Error("Operational product not found for this D1 Product ID.");
  const variants = await database
    .prepare(
      `
      SELECT id, sku, title, price, compare_price, weight_grams, stock
      FROM product_variants WHERE product_id = ? ORDER BY id ASC
    `,
    )
    .bind(product.id)
    .all<Record<string, unknown>>();
  return {
    key,
    operationalFacts: { product, variants: variants.results ?? [] },
  };
}

const HOME_SHAPE = `hero {title, description, ratingLabel}; catalog, solutionsHeading, proofsHeading each {title,description}; heroHighlights [{label,icon}]; heroSlides [{image,alt,badge,text}]; solutions [{title,excerpt,image,optional href,optional crop}]; proofs [{name,location,story,image}]`;
const PRODUCT_SHAPE = `contentName, headline, subheadline, seoTitle, seoDescription, image, heroImage, tag, relatedCategories[], optional relatedTags[], description, benefits[], keyPoints[], idealFor[], offerText, ctaText, optional ratingValue/reviewCount/soldCount, reviews [{name,location,avatar,verified,date,comment,rating}]`;

export const PUT: APIRoute = async ({ request, locals }) => {
  const database = databaseFrom(locals);
  if (!database)
    return json({ success: false, error: "Database unavailable." }, 503);
  if (Number(request.headers.get("content-length") || 0) > 70_000) {
    return json({ success: false, error: "Request body exceeds 70 KiB." }, 413);
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "save-instructions") {
      if (locals.admin?.role !== "owner") {
        return json(
          {
            success: false,
            error: "Only the tenant owner may change AI instructions.",
            code: "OWNER_REQUIRED",
          },
          403,
        );
      }
      if (typeof body.instructions !== "string")
        throw new Error("Instructions must be text.");
      const instructions = body.instructions.trim();
      if (instructions.length < 20 || instructions.length > 8_000) {
        throw new Error("Instructions must contain 20-8000 characters.");
      }
      const result = await database
        .prepare(
          "UPDATE stores SET ai_content_instructions = ? WHERE id = (SELECT id FROM stores ORDER BY id ASC LIMIT 1)",
        )
        .bind(instructions)
        .run();
      if (!result.success || !result.meta.changes)
        throw new Error("Store configuration is missing.");
      return json({ success: true, data: { instructionsConfigured: true } });
    }

    const expectedVersion = readExpectedVersion(body);
    if (
      (action === "save-draft" || action === "publish" || action === "generate") &&
      expectedVersion === null
    ) {
      return json(
        {
          success: false,
          code: "CONTENT_VERSION_REQUIRED",
          error: "Editor konten sudah usang. Muat ulang halaman, lalu coba lagi.",
        },
        428,
      );
    }

    if (action === "save-draft") {
      const { key, version } = await saveDraft(
        database,
        body.key,
        body.content,
        "manual",
        expectedVersion!,
      );
      return json({ success: true, data: { key: key.key, status: "draft", version } });
    }

    if (action === "publish") {
      const key = parseContentKey(body.key);
      // Version 0 only ever creates a draft; there is nothing to publish onto.
      if (expectedVersion === 0) {
        const current = await currentVersion(database, key.key);
        if (current === null) throw new Error("A valid draft is required before publication.");
        throw new ContentVersionConflict(current);
      }
      const now = new Date().toISOString();
      const result = await database
        .prepare(
          `
          UPDATE storefront_content
          SET published_json = draft_json, published_at = ?, updated_at = ?,
            version = version + 1
          WHERE content_key = ? AND version = ? AND draft_json IS NOT NULL
        `,
        )
        .bind(now, now, key.key, expectedVersion)
        .run();
      if (!result.success) throw new Error("D1 rejected the publication.");
      if (!result.meta.changes) {
        const row = await database
          .prepare(
            "SELECT version, draft_json IS NOT NULL AS has_draft FROM storefront_content WHERE content_key = ? LIMIT 1",
          )
          .bind(key.key)
          .first<{ version: number; has_draft: number }>();
        if (row && Number(row.version) === expectedVersion && !row.has_draft) {
          throw new Error("A valid draft is required before publication.");
        }
        throw new ContentVersionConflict(row ? Number(row.version) : null);
      }
      return json({
        success: true,
        data: { key: key.key, status: "published", version: expectedVersion! + 1 },
      });
    }

    if (action === "generate") {
      // ADR-041: AI drafting needs a live subscription (checked before the cap is spent).
      const billing = locals.billing;
      if (billing && !isLive(billing.state)) return json(subscriptionRefusalBody(billing.state), 402);
      // A stale editor is refused before the cap is spent or the model runs;
      // the write below checks again, for a save that lands while it runs.
      const generateKey = parseContentKey(body.key);
      const loaded = await currentVersion(database, generateKey.key);
      if ((loaded ?? 0) !== expectedVersion) return versionConflict(loaded);
      // T-37: the plan's hourly AI cap, per tenant, spent before the model runs.
      const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
      const aiCap = await checkPlanCap(platformDb, locals.tenantContext?.tenantId, "ai", true);
      if (!aiCap.allowed) return json({ success: false, error: aiCap.error }, 429);
      const store = await database
        .prepare(
          "SELECT ai_content_instructions FROM stores ORDER BY id ASC LIMIT 1",
        )
        .first<{ ai_content_instructions: string | null }>();
      const instructions = store?.ai_content_instructions?.trim() || "";
      const aiValue = getRuntimeEnv(locals)?.AI;
      if (
        !aiValue ||
        typeof aiValue !== "object" ||
        !("run" in aiValue) ||
        typeof aiValue.run !== "function"
      ) {
        throw new Error("Workers AI binding is unavailable.");
      }
      // The runtime guard above verifies the binding method before narrowing the generated Cloudflare type.
      const ai = aiValue as Ai;
      const context = await generationContext(database, body.key);
      const shape = context.key.type === "home" ? HOME_SHAPE : PRODUCT_SHAPE;
      const result = await ai.run(MODEL, {
        messages: [
          {
            role: "system",
            content: `${buildContentSystemInstruction(instructions)}\n\nRequired shape: ${shape}`,
          },
          {
            role: "user",
            content: `Create ${context.key.key} storefront content. Operational facts are read-only context: ${JSON.stringify(context.operationalFacts)}`,
          },
        ],
        response_format: { type: "json_object" },
      });
      const unknownResult = result as unknown;
      let responseValue = unknownResult;
      if (
        unknownResult &&
        typeof unknownResult === "object" &&
        "response" in unknownResult
      ) {
        responseValue = unknownResult.response;
      }
      const candidate =
        typeof responseValue === "string"
          ? JSON.parse(responseValue)
          : responseValue;
      // A save that landed while the model ran wins: this result is discarded (409).
      const { key, version } = await saveDraft(
        database,
        context.key.key,
        candidate,
        "workers-ai",
        expectedVersion!,
      );
      return json({
        success: true,
        data: { key: key.key, status: "draft", generatedBy: "workers-ai", version },
      });
    }

    return json({ success: false, error: "Unsupported content action." }, 400);
  } catch (error) {
    if (error instanceof ContentVersionConflict) return versionConflict(error.currentVersion);
    const invalid = contentValidationMessage(error);
    const message = invalid ?? errorMessage(error);
    const status =
      invalid || /not found|required|must|invalid|exceeds|configured|allowed|key/i.test(
        message,
      )
        ? 400
        : 500;
    return json({ success: false, error: message }, status);
  }
};
