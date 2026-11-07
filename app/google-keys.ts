/**
 * Trusted key retrieval for Google ID-token verification. Neither the discovery
 * URL nor the accepted JWKS URL is derived from a token or a request.
 */
export type GooglePublicKey = JsonWebKey & { kid: string };

type KeyStoreOptions = {
  fetcher?: typeof fetch;
  nowMs?: () => number;
};

const DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_DOCUMENT_BYTES = 65_536;
const MAX_KEYS = 32;
const MAX_CACHE_SECONDS = 3_600;
const UNKNOWN_KEY_REFRESH_INTERVAL_MS = 30_000;
const FAILED_REFRESH_INTERVAL_MS = 5_000;
const UNCACHED_REFRESH_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 8_000;

function unavailable(): never {
  throw new Error("GOOGLE_KEYS_UNAVAILABLE");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readDocument(fetcher: typeof fetch, url: string): Promise<{ value: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch {
    return unavailable();
  }
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) unavailable();
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_DOCUMENT_BYTES)) unavailable();
  if (!response.body) unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return unavailable();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { value, headers: response.headers };
  } catch {
    return unavailable();
  } finally {
    reader.releaseLock();
  }
}

function cacheMilliseconds(headers: Headers, requestedAt: number, completedAt: number): number {
  if (!Number.isFinite(requestedAt) || !Number.isFinite(completedAt) || completedAt < requestedAt) unavailable();
  const control = headers.get("cache-control") ?? "";
  const noCache = /(?:^|,)\s*(?:no-store|no-cache)\s*(?:=|,|$)/i.test(control);
  const matches = [...control.matchAll(/(?:^|,)\s*max-age\s*=\s*(?:"([0-9]+)"|([0-9]+))\s*(?=,|$)/gi)];
  if (matches.length !== 1) return 0;
  const maxAge = Number(matches[0][1] ?? matches[0][2]);
  const ageText = headers.get("age");
  if (!Number.isSafeInteger(maxAge) || (ageText !== null && !/^\d+$/.test(ageText))) return 0;
  const age = ageText === null ? 0 : Number(ageText);
  if (!Number.isSafeInteger(age)) return 0;
  const dateText = headers.get("date");
  const date = dateText === null ? completedAt : Date.parse(dateText);
  if (!Number.isFinite(date)) return 0;
  const apparentAge = Math.max(age * 1_000, Math.max(0, completedAt - date)) + (completedAt - requestedAt);
  if (maxAge > 0 && apparentAge >= maxAge * 1_000) unavailable();
  if (noCache) return 0;
  return Math.max(0, Math.min(MAX_CACHE_SECONDS * 1_000, maxAge * 1_000 - apparentAge));
}

function parseKeys(value: unknown): GooglePublicKey[] {
  if (!isObject(value) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > MAX_KEYS) unavailable();
  const seen = new Set<string>();
  const keys: GooglePublicKey[] = [];
  for (const item of value.keys) {
    if (!isObject(item) || typeof item.kid !== "string" || !item.kid || item.kid.length > 256 ||
        seen.has(item.kid) || typeof item.kty !== "string") unavailable();
    seen.add(item.kid);
    if (item.kty !== "RSA") continue;
    if (typeof item.n !== "string" || item.n.length > 1366 || !/^[A-Za-z0-9_-]+$/.test(item.n) ||
        typeof item.e !== "string" || item.e.length > 8 || !/^[A-Za-z0-9_-]+$/.test(item.e) ||
        (item.use !== undefined && item.use !== "sig") || (item.alg !== undefined && item.alg !== "RS256") ||
        (item.key_ops !== undefined && (!Array.isArray(item.key_ops) || !item.key_ops.every((v) => typeof v === "string") || !item.key_ops.includes("verify")))) unavailable();
    const key: GooglePublicKey = { kid: item.kid, kty: "RSA", n: item.n, e: item.e };
    if (typeof item.use === "string") key.use = item.use;
    if (typeof item.alg === "string") key.alg = item.alg;
    if (Array.isArray(item.key_ops)) key.key_ops = [...item.key_ops] as string[];
    keys.push(key);
  }
  if (keys.length === 0) unavailable();
  return keys;
}

export function createGoogleKeyStore(options: KeyStoreOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  let keys: GooglePublicKey[] = [];
  let expiresAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastAttemptFailed = false;
  let lastRefreshWasUncached = false;
  let lastSeenKids = new Set<string>();
  let inFlight: Promise<GooglePublicKey[]> | null = null;

  async function refresh() {
    lastAttemptAt = nowMs();
    try {
      const discovery = await readDocument(fetcher, DISCOVERY_URL);
      if (!isObject(discovery.value) ||
          discovery.value.issuer !== "https://accounts.google.com" ||
          discovery.value.jwks_uri !== JWKS_URL) unavailable();
      const requestedAt = nowMs();
      const jwks = await readDocument(fetcher, JWKS_URL);
      const newKeys = parseKeys(jwks.value);
      const currentTime = nowMs();
      if (!Number.isFinite(currentTime)) unavailable();
      const lifetime = cacheMilliseconds(jwks.headers, requestedAt, currentTime);
      keys = lifetime > 0 ? newKeys : [];
      lastSeenKids = lifetime > 0 ? new Set(newKeys.map((key) => key.kid)) : new Set();
      expiresAt = currentTime + lifetime;
      lastAttemptAt = currentTime;
      lastRefreshWasUncached = lifetime === 0;
      lastAttemptFailed = false;
      return newKeys;
    } catch {
      const failedAt = nowMs();
      if (Number.isFinite(failedAt)) lastAttemptAt = failedAt;
      lastAttemptFailed = true;
      unavailable();
    }
  }

  async function keysFor(kid: string): Promise<{ keys: GooglePublicKey[] }> {
    if (typeof kid !== "string" || !kid || kid.length > 256) unavailable();
    const currentTime = nowMs();
    if (!Number.isFinite(currentTime)) unavailable();
    const cacheValid = currentTime < expiresAt;
    if (cacheValid && keys.some((key) => key.kid === kid)) {
      return { keys: keys.map((key) => ({ ...key, key_ops: key.key_ops && [...key.key_ops] })) };
    }
    if (!inFlight) {
      const elapsed = currentTime - lastAttemptAt;
      const unknownKey = lastSeenKids.size > 0 && !lastSeenKids.has(kid);
      const minimumInterval = Math.max(
        lastAttemptFailed ? FAILED_REFRESH_INTERVAL_MS : 0,
        lastRefreshWasUncached ? UNCACHED_REFRESH_INTERVAL_MS : 0,
        unknownKey ? UNKNOWN_KEY_REFRESH_INTERVAL_MS : 0,
      );
      if (elapsed < minimumInterval) unavailable();
      inFlight = refresh();
    }
    let refreshed: GooglePublicKey[];
    try {
      refreshed = await inFlight;
    } finally {
      inFlight = null;
    }
    if (!refreshed.some((key) => key.kid === kid)) unavailable();
    return { keys: refreshed.map((key) => ({ ...key, key_ops: key.key_ops && [...key.key_ops] })) };
  }
  return { keysFor };
}
