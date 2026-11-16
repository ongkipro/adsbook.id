import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { resetTeamMemberAccess, setTeamMemberDisabled, setTeamMemberRole } from "../../../../platform/admin/team.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };

/**
 * UX-10: one action on one member, owner only, each audited:
 * `{ op: "disable" | "enable" }`, `{ op: "role", role }`, `{ op: "reset", password }`.
 * A reset returns the new TOTP secret in this one response and nowhere else.
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { op?: unknown; role?: unknown; password?: unknown };
  const id = String(params.id ?? "");
  if (body.op === "disable" || body.op === "enable") {
    const result = await setTeamMemberDisabled(platformDb, user, id, body.op === "disable");
    return result.ok
      ? Response.json({ success: true, message: result.message }, { headers: noStore })
      : Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
  }
  if (body.op === "role") {
    const result = await setTeamMemberRole(platformDb, user, id, body.role);
    return result.ok
      ? Response.json({ success: true, message: result.message }, { headers: noStore })
      : Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
  }
  if (body.op === "reset") {
    const result = await resetTeamMemberAccess(platformDb, user, id, body.password);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
    return Response.json(
      { success: true, message: result.message, data: { email: result.value!.email, totp_secret: result.value!.totpSecret, otpauth_uri: result.value!.otpauthUri } },
      { headers: noStore },
    );
  }
  return Response.json({ success: false, error: "Aksi tidak dikenal." }, { status: 400, headers: noStore });
};
