import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { getClientIp } from "../../../lib/rate-limit.ts";
import { ensureControlPlane } from "../../../platform/control-plane.ts";
import { consumeCredentialGrant, credentialLinkPolicy, peekCredentialGrant } from "../../../platform/admin/credentials.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

/**
 * IAM-11: redeem a single-use operator link, no session (the link is the
 * proof, the enrolled or new authenticator the second factor). The token
 * travels in this POST body, never in a URL. `{ op: "peek", token }` reads
 * what the link is for; `{ op: "use", token, password, totp, totp_secret? }`
 * redeems it. Strict same-origin is enforced by the platform guard.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  // Read at each use (and again at commit), not once here.
  const links = () => credentialLinkPolicy(env);
  if (!platformDb) return Response.json({ success: false, error: "Belum tersedia." }, { status: 503, headers: noStore });
  await ensureControlPlane(platformDb);
  const parsed: unknown = await request.json().catch(() => null);
  // Valid JSON can still be `null`, an array or a string: only an object is a request.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ success: false, error: "Payload tidak valid." }, { status: 400, headers: noStore });
  }
  const body = parsed as Record<string, unknown>;
  const ip = getClientIp(request.headers);
  if (body.op === "peek") {
    const result = await peekCredentialGrant(platformDb, body.token, ip, links);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
    const { purpose, email, totpSecret, otpauthUri } = result.value!;
    return Response.json({ success: true, data: { purpose, email, totp_secret: totpSecret, otpauth_uri: otpauthUri } }, { headers: noStore });
  }
  if (body.op === "use") {
    const result = await consumeCredentialGrant(platformDb, body.token, { password: body.password, totp: body.totp, totpSecret: body.totp_secret }, ip, links);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
    return Response.json({ success: true, message: result.message }, { headers: noStore });
  }
  return Response.json({ success: false, error: "Aksi tidak dikenal." }, { status: 400, headers: noStore });
};
