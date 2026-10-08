/**
 * Parse the expiration (exp) Unix timestamp in seconds from a JWT string or a cookie string.
 * Returns null if the token is opaque, malformed, or has no numeric exp claim.
 */
export function parseJwtExpiry(tokenOrCookie?: string): number | null {
  if (!tokenOrCookie || typeof tokenOrCookie !== "string") return null;

  const tokenMatch = tokenOrCookie.match(/(?:^|;\s*)token=([^;]+)/);
  const candidate = tokenMatch ? tokenMatch[1] : tokenOrCookie.trim();

  try {
    const token = decodeURIComponent(candidate.trim());
    const segments = token.split(".");
    if (segments.length !== 3 || !segments[1]) return null;

    const payloadJson = Buffer.from(segments[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return exp;
  } catch {
    return null;
  }
}

/**
 * Check if a token in a cookie or raw string expires within the given threshold (in minutes).
 * Returns false if the token has no parseable JWT exp claim.
 */
export function isTokenExpiringSoon(
  cookie: string,
  minutesBeforeExpiry = 5,
): boolean {
  const exp = parseJwtExpiry(cookie);
  if (exp === null) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  const thresholdSec = minutesBeforeExpiry * 60;
  return exp - nowSec < thresholdSec;
}
