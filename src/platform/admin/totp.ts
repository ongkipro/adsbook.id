/**
 * TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) for platform sign-in
 * (IAM-3, spec 07 "password + TOTP"). A code from the step before or after is
 * accepted for clock skew; the secret is base32 as authenticator apps expect.
 */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function totpCode(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

/** The 30-second step the code belongs to, or null. The caller claims the step once (replay). */
export async function verifyTotp(secret: string | null | undefined, code: unknown, now = Date.now()): Promise<number | null> {
  if (!secret || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return null;
  const step = Math.floor(now / 30_000);
  let match: number | null = null;
  for (const drift of [-1, 0, 1]) {
    // Every candidate is computed and compared, so timing does not reveal which matched.
    const expected = await totpCode(secret, step + drift);
    let diff = 0;
    for (let index = 0; index < 6; index += 1) diff |= expected.charCodeAt(index) ^ code.trim().charCodeAt(index);
    if (diff === 0) match = step + drift;
  }
  return match;
}

export function otpauthUri(secret: string, email: string): string {
  return `otpauth://totp/adsbook.id:${encodeURIComponent(email)}?secret=${secret}&issuer=adsbook.id&digits=6&period=30`;
}
