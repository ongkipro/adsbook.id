import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { addTeamMember, listTeam } from "../../../../platform/admin/team.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };

/** UX-10: the platform team, owner only. */
export const GET: APIRoute = async ({ locals }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (user.role !== "platform_owner") return Response.json({ success: false, error: "Hanya owner platform." }, { status: 403 });
  return Response.json({ success: true, data: { team: await listTeam(platformDb) } }, { headers: noStore });
};

/** Adds a member; the TOTP secret is in this one response and nowhere else. */
export const POST: APIRoute = async ({ request, locals }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await addTeamMember(platformDb, user, body);
  if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
  return Response.json(
    { success: true, message: result.message, data: { id: result.value!.id, email: result.value!.email, totp_secret: result.value!.totpSecret, otpauth_uri: result.value!.otpauthUri } },
    { status: 201, headers: noStore },
  );
};
