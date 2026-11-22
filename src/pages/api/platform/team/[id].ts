import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { credentialLinkPolicy } from "../../../../platform/admin/credentials.ts";
import { issueTeamMemberLink, setTeamMemberDisabled, setTeamMemberRole } from "../../../../platform/admin/team.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };

/**
 * UX-10: one action on one member, owner only, each audited:
 * `{ op: "disable" | "enable" }`, `{ op: "role", role }`, `{ op: "link", totp }`.
 * `link` (IAM-11) needs the owner's own fresh TOTP code and returns a single-use
 * password-reset or enrollment link in this one response and nowhere else.
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { op?: unknown; role?: unknown; totp?: unknown };
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
  if (body.op === "link") {
    const result = await issueTeamMemberLink(platformDb, user, id, body.totp, new URL(request.url).origin, () => credentialLinkPolicy(env));
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
    const { email, link, expiresAt, purpose } = result.value!;
    return Response.json({ success: true, message: result.message, data: { email, link, expires_at: expiresAt, purpose } }, { headers: noStore });
  }
  return Response.json({ success: false, error: "Aksi tidak dikenal." }, { status: 400, headers: noStore });
};
