/**
 * Pure post-login validation classification.
 *
 * The non-mutating probe intentionally reads only `/api/v2/users/user/settings`
 * after installing a token. Its result must not be treated as a boolean
 * "logged in" gate without distinguishing a conclusive upstream rejection from
 * an inconclusive probe (timeout, closed page, evaluate error).
 *
 * No imports, no I/O, no side effects.
 */
export type AuthValidationState = "valid" | "rejected" | "inconclusive";

export interface PostLoginValidationInput {
  /** probePageLoggedIn reason, e.g. "ok", "settings-401", "timeout". */
  reason?: string | null;
  /** settings HTTP status when known; 0/undefined means not observed. */
  settingsStatus?: number | null;
  /** settings app-level failure (success:false / Unauthorized). */
  settingsAppFail?: boolean | null;
}

/** Reasons that prove the upstream session is not authenticated. */
const REJECTED_REASONS = new Set([
  "settings-401",
  "settings-403",
  "settings-revoked",
  // Full-probe/recovery reasons; not emitted by the non-mutating login probe,
  // but classified here so recovery code can reuse the same contract.
  "auths-status",
  "auths-schema",
  "refresh-401",
  "refresh-403",
  "refresh-revoked",
]);

/** Reasons that mean "we could not decide", not "the session is bad". */
const INCONCLUSIVE_REASONS = new Set([
  "timeout",
  "evaluate-error",
  "page-closed",
  "no-page",
  "auth-url",
  "logged-out-marker",
]);

export function classifyPostLoginValidation(
  input: PostLoginValidationInput,
): AuthValidationState {
  const reason = (input.reason ?? "").trim();

  if (reason === "ok") return "valid";
  if (REJECTED_REASONS.has(reason)) return "rejected";
  if (INCONCLUSIVE_REASONS.has(reason)) return "inconclusive";

  const status = input.settingsStatus;
  if (status === 401 || status === 403) return "rejected";
  if (status === 200 && input.settingsAppFail === true) return "rejected";
  if (status === 200 && input.settingsAppFail === false) return "valid";

  // Unknown/ambiguous: never accept without evidence.
  return "inconclusive";
}

/**
 * READY is removed only for a conclusive rejection. Inconclusive/deferred
 * must preserve an existing READY state; they are not evidence of invalidity.
 */
export function shouldUnmarkReadyAfterRecovery(
  outcome: "verified" | "rejected" | "inconclusive" | "deferred" | "page-required",
): boolean {
  return outcome === "rejected";
}
