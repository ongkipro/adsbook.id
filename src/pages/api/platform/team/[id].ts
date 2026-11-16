import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { setTeamMemberDisabled } from "../../../../platform/admin/team.ts";

export const prerender = false;

/** UX-10: `{ op: "disable" | "enable" }` on one member, owner only, audited. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { op?: unknown };
  if (body.op !== "disable" && body.op !== "enable") return Response.json({ success: false, error: "Aksi tidak dikenal." }, { status: 400 });
  const result = await setTeamMemberDisabled(platformDb, user, String(params.id ?? ""), body.op === "disable");
  return result.ok
    ? Response.json({ success: true, message: result.message }, { headers: { "cache-control": "private, no-store" } })
    : Response.json({ success: false, error: result.error }, { status: result.status });
};
