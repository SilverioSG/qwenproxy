/**
 * Shared-WAF circuit breaker (Fix E).
 *
 * A punish challenge answered in headless production has no human to solve
 * it. Without shared state, one client request walks the whole pool burning
 * ~300s per account (observed: 9+ accounts, ~2h worst case) and parks every
 * tried account with AuthInitFailed. This module is the minimal shared
 * memory that stops that cascade:
 *
 * - punish observations are recorded per account + signature;
 * - two INDEPENDENT accounts punished with the SAME signature open the
 *   circuit for a short TTL;
 * - while open, requests fail fast with a retryable 429 instead of
 *   consuming more accounts, waiting on humans, or cooling anyone.
 *
 * Properties: RAM only (no DB, reset on restart), short TTL, lazy expiry,
 * synchronous map operations (no interleaving within a tick; concurrent
 * requests may overshoot by ~1 probe, which is bounded and documented, not
 * a storm). No adaptive complexity, no per-request bookkeeping here — the
 * request flow bounds itself (same-account retry once, then at most one
 * rotation probe) and consults this module at each step.
 *
 * SECURITY: signatures are normalized classes ("punish_url", "rgv587",
 * "waf-challenge"), never URLs, bodies, cookies or tokens.
 */

/** Short enough to resume fast, long enough to ride out a punish storm. */
/** Matches the parse-guard breaker precedent (60s open window). */
export const WAF_CIRCUIT_TTL_MS = 60_000;

/** Maximum retained observations; bounds memory under a many-account storm. */
const MAX_OBSERVATIONS = 200;

/** Normalized punish class. Never a URL, body, cookie or token. */
export type WafSignature = string;

export function wafSignatureFromDirectResult(
  punishUrl: string | null | undefined,
  challengeBody?: string | null,
): WafSignature {
  if (punishUrl) return "punish_url";
  const body = (challengeBody ?? "").toLowerCase();
  if (body.includes("rgv587") || body.includes("fail_sys_user_validate")) {
    return "rgv587";
  }
  return "waf-challenge";
}

interface WafCircuitState {
  signature: WafSignature;
  openedAt: number;
  activeUntil: number;
  /** Account id8s that independently confirmed the signature. */
  confirmations: string[];
}

let circuit: WafCircuitState | null = null;

interface WafObservation {
  signature: WafSignature;
  accountId: string;
  at: number;
}

const observations: WafObservation[] = [];

function pruneObservations(nowMs: number): void {
  while (
    observations.length > 0 &&
    nowMs - observations[0].at > WAF_CIRCUIT_TTL_MS
  ) {
    observations.shift();
  }
}

/**
 * Record a persisted punish (same signature refused twice on one account,
 * or any confirmed punish) and report whether the WAF is now known-shared.
 * Opens the circuit on the SECOND independent account with the same
 * signature. `nowMs` is injectable for deterministic tests.
 */
export function recordWafPunish(
  accountId: string,
  signature: WafSignature,
  nowMs: number = Date.now(),
): { shared: boolean; confirmations: number } {
  pruneObservations(nowMs);
  if (
    !observations.some(
      (o) => o.accountId === accountId && o.signature === signature,
    )
  ) {
    observations.push({ signature, accountId, at: nowMs });
    while (observations.length > MAX_OBSERVATIONS) observations.shift();
  }
  const distinct = [
    ...new Set(
      observations
        .filter((o) => o.signature === signature)
        .map((o) => o.accountId),
    ),
  ];
  if (
    distinct.length >= 2 &&
    (!circuit || circuit.signature !== signature || nowMs >= circuit.activeUntil)
  ) {
    circuit = {
      signature,
      openedAt: nowMs,
      activeUntil: nowMs + WAF_CIRCUIT_TTL_MS,
      confirmations: distinct,
    };
  }
  return { shared: isWafCircuitOpen(signature, nowMs), confirmations: distinct.length };
}

/** True while a shared-WAF circuit is open (lazily expires it). */
export function isWafCircuitOpen(
  signature?: WafSignature,
  nowMs: number = Date.now(),
): boolean {
  if (!circuit) return false;
  if (nowMs >= circuit.activeUntil) {
    circuit = null;
    return false;
  }
  return signature === undefined || signature === circuit.signature;
}

/** Remaining open time, 0 when closed. Drives client retry-after bookkeeping. */
export function wafCircuitTtlRemainingMs(nowMs: number = Date.now()): number {
  if (!circuit || nowMs >= circuit.activeUntil) return 0;
  return circuit.activeUntil - nowMs;
}

/** Current circuit signature, null when closed. For error construction. */
export function getWafCircuitSignature(nowMs: number = Date.now()): WafSignature | null {
  if (!circuit || nowMs >= circuit.activeUntil) return null;
  return circuit.signature;
}

/** Sanitized view for logs/diagnostics. No secrets by construction. */
export function describeWafCircuit(nowMs: number = Date.now()): Record<string, unknown> {
  if (!circuit || nowMs >= circuit.activeUntil) return { open: false };
  return {
    open: true,
    signature: circuit.signature,
    ttlMs: circuit.activeUntil - nowMs,
    confirmations: circuit.confirmations.length,
  };
}

/**
 * Fast-fail error while the shared-WAF circuit is open. Carries an explicit
 * 429 hint so the API layer answers retryable without touching accounts,
 * cooldowns or rotation. Never matches quota/auth/anti-bot classifiers
 * (plain message, no markers) — the request loops check it explicitly first.
 */
export class SharedWafCircuitError extends Error {
  readonly signature: string;
  readonly retryAfterMs: number;
  readonly upstreamStatus = 429;
  constructor(signature: string, retryAfterMs: number) {
    super(`shared-waf-circuit-open:${signature}`);
    this.name = "SharedWafCircuitError";
    this.signature = signature;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isSharedWafCircuitError(err: unknown): err is SharedWafCircuitError {
  return err instanceof SharedWafCircuitError;
}

/** @internal test seam. */
export function _resetWafCircuitForTests(): void {
  circuit = null;
  observations.length = 0;
}
