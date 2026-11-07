/**
 * Verify a Google ID token against caller-supplied, already trusted Google keys.
 * The production caller must fetch keys from Google's fixed discovery/JWKS
 * endpoint, never from the token or an untrusted request.
 */
export type GoogleIdentity = {
  sub: string;
  email: string;
  name?: string;
};

export type GoogleOidcOptions = {
  audience: string;
  nonce: string;
  nowSeconds: number;
  jwks: { keys: (JsonWebKey & { kid?: string })[] };
};

const MAX_TOKEN_LENGTH = 16_384;
const MAX_JSON_SEGMENT_LENGTH = 8_192;
const MAX_CLOCK_SKEW_SECONDS = 60;

function invalid(): never {
  throw new Error("INVALID_GOOGLE_ID_TOKEN");
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) invalid();
  let decoded: string;
  try {
    decoded = atob(segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "="));
  } catch {
    return invalid();
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (canonical !== segment) invalid();
  return bytes;
}

function decodeObject(segment: string): Record<string, unknown> {
  if (segment.length > MAX_JSON_SEGMENT_LENGTH) invalid();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(segment));
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
    return parsed as Record<string, unknown>;
  } catch {
    return invalid();
  }
}

export async function verifyGoogleIdToken(token: string, options: GoogleOidcOptions): Promise<GoogleIdentity> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH ||
      !options || typeof options.audience !== "string" || !options.audience ||
      typeof options.nonce !== "string" || !options.nonce ||
      !Number.isFinite(options.nowSeconds) || !Array.isArray(options.jwks?.keys)) invalid();

  const segments = token.split(".");
  if (segments.length !== 3) invalid();
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = decodeObject(encodedHeader);
  const claims = decodeObject(encodedClaims);
  const signature = decodeSegment(encodedSignature);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
      header.crit !== undefined || header.b64 !== undefined ||
      (header.typ !== undefined && header.typ !== "JWT")) invalid();

  const matches = options.jwks.keys.filter((key) => key && typeof key === "object" && key.kid === header.kid);
  if (matches.length !== 1) invalid();
  const key = matches[0];
  if (key.kty !== "RSA" || (key.use !== undefined && key.use !== "sig") ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) ||
      typeof key.n !== "string" || typeof key.e !== "string" || key.n.length > 1366 || key.e.length > 8) invalid();
  const modulus = decodeSegment(key.n);
  if (modulus.length < 256 || modulus.length > 1024 || modulus[0] < 128) invalid();
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", publicKey, signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!valid) invalid();
  } catch {
    return invalid();
  }

  const audienceMatches = claims.aud === options.audience ||
    (Array.isArray(claims.aud) && claims.aud.length > 0 &&
      claims.aud.every((item) => typeof item === "string" && item.length > 0) &&
      claims.aud.includes(options.audience));
  if ((claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") ||
      !audienceMatches ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== options.audience) ||
      (claims.azp !== undefined && claims.azp !== options.audience) ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= options.nowSeconds ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) ||
      claims.iat > options.nowSeconds + MAX_CLOCK_SKEW_SECONDS || claims.iat >= claims.exp ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > options.nowSeconds)) ||
      claims.nonce !== options.nonce ||
      typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) ||
      typeof claims.email !== "string" || !claims.email.trim() || claims.email_verified !== true ||
      (claims.name !== undefined && typeof claims.name !== "string")) invalid();

  return { sub: claims.sub, email: claims.email, ...(typeof claims.name === "string" ? { name: claims.name } : {}) };
}
