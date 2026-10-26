/**
 * Auth recovery coordinator (Phase 2B).
 *
 * Demand-driven, per-account state machine. It never starts timers, never
 * opens a second login architecture, and never touches tokens/cookies/profiles.
 * It reuses the existing session verifier (`ensureAccountSession`) and the
 * existing concurrency/cooldown/manual-verification gates.
 *
 * States:
 *   idle -> scheduled -> recovering -> verified | rejected | inconclusive
 *                                      -> backoff -> (next explicit call)
 *
 * A blocked account (busy/stream/cooldown/manual verification) is moved to
 * backoff without running verification. Rejected is not retried immediately;
 * manual verification is recommended. Inconclusive is retried only after a
 * bounded backoff and a limited number of attempts.
 *
 * No global lock: each account has its own entry and in-flight promise.
 */
import { config } from "../core/config.ts";
import {
  hasOtherActiveAccountLeaseByLeaseId,
  isAccountBusy,
  isAccountTemporarilyBusy,
} from "../core/account-concurrency.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { logger } from "../core/logger.ts";

export type AuthRecoveryState =
  | "idle"
  | "scheduled"
  | "recovering"
  | "verified"
  | "rejected"
  | "inconclusive"
  | "backoff";

export type AuthRecoveryOutcome =
  | "verified"
  | "rejected"
  | "inconclusive"
  | "deferred"
  | "page-required";

export interface AuthRecoveryResult {
  accountId: string;
  state: AuthRecoveryState;
  outcome: AuthRecoveryOutcome;
  reason?: string;
  attempts: number;
  nextAttemptAt: number;
  manualVerificationRecommended: boolean;
  pageRequired?: boolean;
}

export interface AuthRecoveryVerification {
  state: "valid" | "rejected" | "inconclusive";
  reason?: string;
  pageRequired?: boolean;
}

export interface AuthRecoveryDeps {
  verifySession(accountId: string): Promise<AuthRecoveryVerification>;
  hasActiveStream(accountId: string, ownerLeaseId?: string): boolean;
  isBusy(accountId: string, ownerLeaseId?: string): boolean;
  isOnCooldown(accountId: string): boolean;
  hasActiveManualVerification(accountId: string): Promise<boolean>;
  recommendManualVerification?(accountId: string, reason?: string): void;
  now(): number;
  blockedBackoffMs: number;
  rejectedBackoffMs: number;
  inconclusiveBackoffMs: number;
  maxInconclusiveAttempts: number;
}

interface Entry {
  state: AuthRecoveryState;
  attempts: number;
  inconclusiveAttempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  reason?: string;
  manualVerificationRecommended: boolean;
  pageRequired: boolean;
  inFlight?: Promise<AuthRecoveryResult>;
}

const defaultDeps: AuthRecoveryDeps = {
  async verifySession(accountId) {
    const { ensureAccountSession } = await import("./qwen-token-refresh.ts");
    const session = await ensureAccountSession(accountId);
    return {
      state: session.sessionVerified,
      reason: session.verificationReason,
      pageRequired: session.pageRequired,
    };
  },
  hasActiveStream(accountId, ownerLeaseId) {
    return hasOtherActiveAccountLeaseByLeaseId(accountId, ownerLeaseId);
  },
  isBusy(accountId, ownerLeaseId) {
    if (isAccountTemporarilyBusy(accountId)) return true;
    // A foreground caller owns one lease. Capacity is not a reason to block it;
    // leases owned by other requests are handled by hasActiveStream(ownerLeaseId).
    if (ownerLeaseId) return false;
    return isAccountBusy(accountId);
  },
  isOnCooldown(accountId) {
    return getAccountCooldownInfo(accountId) !== null;
  },
  async hasActiveManualVerification(accountId) {
    try {
      const { getManualVerificationStatus } = await import(
        "./manual-verification.ts"
      );
      const status = getManualVerificationStatus(accountId);
      if (!status) return false;
      return !["verified", "failed", "cancelled"].includes(status.state);
    } catch {
      return false;
    }
  },
  recommendManualVerification(accountId, reason) {
    logger.warn(
      `[AuthRecovery] manual verification recommended | account=${accountId.slice(0, 8)} | reason=${reason ?? "rejected"}`,
    );
  },
  now() {
    return Date.now();
  },
  blockedBackoffMs: config.concurrency.busyWaitMs,
  rejectedBackoffMs: config.concurrency.initFailureCooldownMs,
  inconclusiveBackoffMs: 60_000,
  maxInconclusiveAttempts: 3,
};

let deps: AuthRecoveryDeps = { ...defaultDeps };
const entries = new Map<string, Entry>();

function entryFor(accountId: string): Entry {
  let entry = entries.get(accountId);
  if (!entry) {
    entry = {
      state: "idle",
      attempts: 0,
      inconclusiveAttempts: 0,
      lastAttemptAt: 0,
      nextAttemptAt: 0,
      manualVerificationRecommended: false,
      pageRequired: false,
    };
    entries.set(accountId, entry);
  }
  return entry;
}

function resultFor(
  accountId: string,
  entry: Entry,
  outcome: AuthRecoveryOutcome,
): AuthRecoveryResult {
  return {
    accountId,
    state: entry.state,
    outcome,
    reason: entry.reason,
    attempts: entry.attempts,
    nextAttemptAt: entry.nextAttemptAt,
    manualVerificationRecommended: entry.manualVerificationRecommended,
    pageRequired: entry.pageRequired,
  };
}

/** @internal test seam */
export function setAuthRecoveryDeps(overrides: Partial<AuthRecoveryDeps>): void {
  deps = { ...deps, ...overrides };
}

/** @internal test seam */
export function resetAuthRecoveryForTests(): void {
  deps = { ...defaultDeps };
  entries.clear();
}

/** @internal test seam */
export function getAuthRecoveryEntryForTests(
  accountId: string,
): Readonly<AuthRecoveryState> | null {
  return entries.get(accountId)?.state ?? null;
}

/** @internal test seam */
export function getAuthRecoveryInFlightCountForTests(): number {
  return [...entries.values()].filter((entry) => entry.inFlight !== undefined)
    .length;
}

export function getAuthRecoveryState(
  accountId: string,
): AuthRecoveryState {
  return entries.get(accountId)?.state ?? "idle";
}

/**
 * Mark an account as eligible for a later explicit recovery call. It does not
 * run anything and does not schedule a timer.
 */
export function scheduleAuthRecovery(
  accountId: string,
  reason?: string,
): AuthRecoveryState {
  if (!accountId) return "idle";
  const entry = entryFor(accountId);
  if (entry.state === "recovering") return entry.state;
  if (entry.nextAttemptAt > deps.now()) {
    return entry.state;
  }
  entry.state = "scheduled";
  entry.reason = reason ?? entry.reason;
  return entry.state;
}

/**
 * Run at most one recovery verification for an account. Concurrent callers
 * share the same in-flight promise. Safe to call repeatedly: rejected and
 * inconclusive states are gated by their backoff window.
 */
export async function recoverAccountSession(
  accountId: string,
  reason?: string,
  opts: { ownerLeaseId?: string } = {},
): Promise<AuthRecoveryResult> {
  if (!accountId) {
    const empty = entryFor("__none__");
    return resultFor("__none__", empty, "deferred");
  }
  const entry = entryFor(accountId);
  if (entry.inFlight) return entry.inFlight;
  const now = deps.now();
  if (entry.nextAttemptAt > now) {
    return resultFor(accountId, entry, "deferred");
  }
  entry.state = "scheduled";
  entry.reason = reason ?? entry.reason;
  const run = (async (): Promise<AuthRecoveryResult> => {
    try {
      const manual = await deps.hasActiveManualVerification(accountId);
      if (
        manual ||
        deps.hasActiveStream(accountId, opts.ownerLeaseId) ||
        deps.isBusy(accountId, opts.ownerLeaseId) ||
        deps.isOnCooldown(accountId)
      ) {
        entry.state = "backoff";
        entry.pageRequired = false;
        entry.reason = manual
          ? "manual-verification-active"
          : deps.hasActiveStream(accountId, opts.ownerLeaseId)
            ? "active-stream"
            : deps.isBusy(accountId, opts.ownerLeaseId)
              ? "busy"
              : "cooldown";
        entry.nextAttemptAt = now + deps.blockedBackoffMs;
        return resultFor(accountId, entry, "deferred");
      }

      entry.state = "recovering";
      entry.lastAttemptAt = now;
      entry.attempts += 1;
      const verification = await deps.verifySession(accountId);
      entry.reason = verification.reason;
      entry.pageRequired = false;

      if (
        verification.state === "inconclusive" &&
        verification.pageRequired === true
      ) {
        entry.state = "backoff";
        entry.pageRequired = true;
        entry.reason = verification.reason ?? "no-live-page";
        entry.nextAttemptAt = now + deps.blockedBackoffMs;
        return resultFor(accountId, entry, "page-required");
      }

      if (verification.state === "valid") {
        entry.state = "verified";
        entry.inconclusiveAttempts = 0;
        entry.nextAttemptAt = 0;
        entry.manualVerificationRecommended = false;
        return resultFor(accountId, entry, "verified");
      }

      if (verification.state === "rejected") {
        entry.state = "rejected";
        entry.inconclusiveAttempts = 0;
        entry.nextAttemptAt = now + deps.rejectedBackoffMs;
        entry.manualVerificationRecommended = true;
        try {
          deps.recommendManualVerification?.(
            accountId,
            verification.reason,
          );
        } catch {
          // Recommendation is advisory; never break recovery.
        }
        return resultFor(accountId, entry, "rejected");
      }

      entry.inconclusiveAttempts += 1;
      entry.state = "inconclusive";
      entry.nextAttemptAt =
        now +
        (entry.inconclusiveAttempts >= deps.maxInconclusiveAttempts
          ? deps.rejectedBackoffMs
          : deps.inconclusiveBackoffMs);
      return resultFor(accountId, entry, "inconclusive");
    } catch (err) {
      entry.state = "inconclusive";
      entry.pageRequired = false;
      entry.reason = err instanceof Error ? err.message : String(err);
      entry.inconclusiveAttempts += 1;
      entry.nextAttemptAt =
        now +
        (entry.inconclusiveAttempts >= deps.maxInconclusiveAttempts
          ? deps.rejectedBackoffMs
          : deps.inconclusiveBackoffMs);
      return resultFor(accountId, entry, "inconclusive");
    } finally {
      entry.inFlight = undefined;
    }
  })();
  entry.inFlight = run;
  return run;
}
