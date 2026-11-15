let cloudflareEnv: Record<string, unknown> | undefined;
try {
  const mod = 'cloudflare:workers';
  const workers = await import(/* @vite-ignore */ mod);
  cloudflareEnv = workers.env;
} catch {
  // Fallback for non-Cloudflare environments (e.g. Node unit test runner)
}

/**
 * The Worker's bindings. Tenant values never come from here (T-21, T-45):
 * identity and provider credentials are rows in the tenant's own store.
 */
type EnvSource = CloudflareRuntimeEnv | Record<string, unknown> | null | undefined;

function normalizeEnvValue(value: unknown) {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = String(value).trim();
  return normalized === '' ? '' : normalized;
}

export function getRuntimeEnv(
  locals?: { runtimeEnv?: CloudflareRuntimeEnv | Record<string, unknown> },
): EnvSource {
  const localEnv = locals?.runtimeEnv;
  if (localEnv && typeof localEnv === 'object') {
    return localEnv;
  }
  return cloudflareEnv as unknown as Record<string, unknown>;
}

/** Nothing of a secret this short may be shown. */
const SECRET_FULLY_MASKED_BELOW = 24;
export const SECRET_MASK = '••••';

/**
 * The browser-safe form of a stored credential.
 *
 * `AGENTS.md` forbids echoing a stored credential back through a browser API,
 * and this is the one function standing between three of them —
 * `meta_capi_token`, and the Mengantar and AutoLaris API keys — and the admin
 * screen. It had no test at all.
 *
 * It also had a branch that revealed most of a short value: five to eight
 * characters came back as `ab••••de`, which for a five-character secret is four
 * of five. The credentials actually in play are long provider tokens, so this
 * was never exploited — but nothing in the type, the column, or the provider
 * contract guarantees a length, and a placeholder an operator pastes while
 * setting up is exactly the short value that branch handled worst.
 *
 * Anything below `SECRET_FULLY_MASKED_BELOW` is therefore shown as mask alone.
 * Above it, four leading and four trailing characters stay — enough for an
 * operator to tell two keys apart, at most a third of a 24-character value and
 * far less of a real one. The dot run is fixed width, so the length of the
 * secret is not disclosed either.
 */
export function maskSecretValue(value: string) {
  const normalized = normalizeEnvValue(value);
  if (normalized === '') return '';
  if (normalized.length < SECRET_FULLY_MASKED_BELOW) return SECRET_MASK;
  return `${normalized.slice(0, 4)}${SECRET_MASK}${normalized.slice(-4)}`;
}
