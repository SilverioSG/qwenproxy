/**
 * HUMAN-ON-DEMAND WAF CHALLENGE.
 *
 * The Aliyun clearance cookie (`x5sec`) that unblocks /api/v2/chat/completions
 * is minted only when a person solves the official Qwen captcha. It cannot be
 * synthesised, and no automated slider driver is used or wanted here.
 *
 * This module therefore does exactly two things, and is deliberately kept
 * separate from the legacy automatic solver in `captcha-coordinator.ts`:
 *
 *   openHumanCaptchaChallenge()  — show the official punish document in the
 *                                  ACCOUNT browser so a person can act on it.
 *   waitForHumanCaptchaClearance() — wait, bounded, until the solve lands
 *                                  (detected by the clearance cookie appearing
 *                                  or changing) and re-read the cookie jar.
 *
 * The legacy `recoverBaxiaCaptcha` / `solveChallengeOnPage` path is untouched
 * and still used by the legacy transport.
 *
 * SECURITY: the punish URL and the clearance value are never logged. Only
 * booleans, lengths and numeric TTLs are emitted.
 */

import type { Page } from "patchright";
import { config } from "../core/config.ts";
import { withAccountPage } from "./playwright.ts";
import { qwenUrl } from "./qwen-url.ts";
import { extractBaxiaChallengeUrl } from "./captcha-solver.ts";
import {
  captureAccountSessionFromPage,
  describeAccountSession,
  invalidateX5sec,
  X5SEC_COOKIE_NAME,
} from "./qwen-account-session.ts";

const CHALLENGE_PATH_MARKER = "_____tmd_____";

/** How long a person is given before the request gives up and fails cleanly. */
const DEFAULT_HUMAN_WAIT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2_000;

export interface HumanChallengeResult {
  /** The challenge document was actually opened in the account browser. */
  opened: boolean;
  /** A person solved it and a fresh clearance is held. */
  solved: boolean;
  /** Clearance TTL at the moment it was observed, ms (0 when none). */
  x5secTtlMs: number;
  waitedMs: number;
  /** Sanitized reason when the wait ended without a clearance. */
  reason: string | null;
  sanitized: Record<string, unknown>;
}

/**
 * Open the official challenge in the account browser and leave it there.
 *
 * The account browser is normally headless in production. A challenge that
 * needs a person is therefore raised on a headed window on demand: the caller
 * surfaces the need (logs + dashboard) and the operator solves it in that
 * window. The page is left on the challenge — navigating away would discard
 * the very document the person is acting on.
 */
export async function openHumanCaptchaChallenge(
  accountId: string,
  options: { challengeBody?: string; label?: string } = {},
): Promise<boolean> {
  const challengeUrl = options.challengeBody
    ? extractBaxiaChallengeUrl(options.challengeBody, config.qwen.baseUrl)
    : null;
  const accountId8 = accountId.slice(0, 8);
  console.warn(
    `🚪 [HumanCaptcha] challenge_opened | account=${accountId8} | source=${challengeUrl ? "response_body" : "chat_reload"}`,
  );
  try {
    return await withAccountPage(
      accountId,
      async (page: Page) => {
        if (page.isClosed()) return false;
        // The WAF answers a background fetch with a punish document that is
        // never rendered, so it has to be navigated to explicitly to become
        // something a person can see and solve.
        await page
          .goto(challengeUrl ?? qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, 8_000),
          })
          .catch(() => undefined);
        return page.url().includes(CHALLENGE_PATH_MARKER) || Boolean(challengeUrl);
      },
      15_000,
      15_000,
      false,
    );
  } catch {
    return false;
  }
}

/**
 * Bounded wait for a person to solve the challenge.
 *
 * Success is detected from the ACCOUNT's own cookie jar: the clearance cookie
 * appearing, or changing value relative to `previousX5secHash`. The wait ends
 * on the first observation of a valid, non-expired clearance; the jar is
 * re-captured in the same page operation so the caller immediately holds the
 * updated cookies.
 */
export async function waitForHumanCaptchaClearance(
  accountId: string,
  options: {
    timeoutMs?: number;
    previousX5secHash?: string | null;
  } = {},
): Promise<HumanChallengeResult> {
  const timeoutMs = Math.max(
    5_000,
    options.timeoutMs ?? DEFAULT_HUMAN_WAIT_MS,
  );
  const accountId8 = accountId.slice(0, 8);
  const startedAt = Date.now();
  const previous = options.previousX5secHash ?? null;
  let opened = false;
  let lastSeen: string | null = previous;

  console.warn(
    `⏳ [HumanCaptcha] awaiting_manual_solve | account=${accountId8} | budget=${Math.round(timeoutMs / 1000)}s`,
  );

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const snap = await withAccountPage(
        accountId,
        async (page: Page) => {
          if (page.isClosed()) return null;
          const cookies = await page.context().cookies();
          const x5 = cookies.find((c) => c.name === X5SEC_COOKIE_NAME);
          const state = await captureAccountSessionFromPage(accountId, page);
          return {
            hash: state.x5secHash,
            valid: state.x5secValid,
            ttlMs: state.x5secExpiresAt
              ? Math.max(0, state.x5secExpiresAt - Date.now())
              : 0,
            state,
          };
        },
        15_000,
        15_000,
        false,
      );
      if (!snap) continue;
      if (!opened) opened = true;
      // A clearance that is new (no previous) OR replaced (different value) and
      // not already expired counts as solved.
      if (snap.valid && snap.hash !== lastSeen) {
        lastSeen = snap.hash;
        console.warn(
          `✅ [HumanCaptcha] solved | account=${accountId8} | x5sec_ttl_ms=${Math.round(snap.ttlMs)} | waited=${Date.now() - startedAt}ms`,
        );
        return {
          opened,
          solved: true,
          x5secTtlMs: snap.ttlMs,
          waitedMs: Date.now() - startedAt,
          reason: null,
          sanitized: describeAccountSession(snap.state),
        };
      }
      lastSeen = snap.hash ?? lastSeen;
    } catch {
      // A transient page error is not a verdict; keep waiting within budget.
    }
  }

  console.warn(
    `⚠️ [HumanCaptcha] timeout | account=${accountId8} | waited=${Date.now() - startedAt}ms`,
  );
  return {
    opened,
    solved: false,
    x5secTtlMs: 0,
    waitedMs: Date.now() - startedAt,
    reason: "human-solve-timeout",
    sanitized: {},
  };
}

/**
 * Full on-demand recovery: open the challenge, wait for the person, and return
 * the refreshed account session. On failure the clearance is invalidated so the
 * next request starts from a known state instead of a suspect cookie.
 */
export async function recoverWithHumanCaptcha(
  accountId: string,
  options: { challengeBody?: string; timeoutMs?: number } = {},
): Promise<{
  solved: boolean;
  x5secTtlMs: number;
  cookieHeader: string | null;
  sanitized: Record<string, unknown>;
}> {
  const { peekAccountSession } = await import("./qwen-account-session.ts");
  const before = peekAccountSession(accountId);
  const previousHash = before?.x5secHash ?? null;
  const opened = await openHumanCaptchaChallenge(accountId, options);
  const result = await waitForHumanCaptchaClearance(accountId, {
    timeoutMs: options.timeoutMs,
    previousX5secHash: previousHash,
  });
  if (!result.solved) {
    invalidateX5sec(accountId);
    return {
      solved: false,
      x5secTtlMs: 0,
      cookieHeader: null,
      sanitized: { opened, ...result.sanitized },
    };
  }
  const after = peekAccountSession(accountId);
  return {
    solved: true,
    x5secTtlMs: result.x5secTtlMs,
    cookieHeader: after?.cookieHeader ?? null,
    sanitized: { opened, ...result.sanitized },
  };
}
