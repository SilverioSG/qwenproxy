/**
 * Stream factory for the DIRECT WEB TRANSPORT.
 *
 * Implements the SAME contract as `createQwenStream` so the chat hot path can
 * swap transports without touching anything downstream: the returned
 * `ReadableStream` is a passthrough of the raw upstream SSE, which is exactly
 * what the legacy factory returns. Every downstream parser keeps working.
 *
 * What this path does NOT do, by design:
 *   - it never calls `captureQwenHeaders` (no UI typing, no send button, no
 *     request interception);
 *   - it never drives the captcha slider (a human solves it on demand);
 *   - it does not need the dedicated Baxia minter (the proven account request
 *     needs the cookie jar + Bearer JWT only).
 *
 * Anything the direct transport does not support is refused up front, so the
 * caller can fall back to the legacy transport instead of silently degrading.
 */

import {
  QWEN_DIRECT_WEB_TRANSPORT_ENABLED,
  directCompletionStream,
  directCreateChat,
  getFrontendVersion,
} from "./qwen-direct-transport.ts";
import {
  captureAccountSession,
  invalidateX5sec,
} from "./qwen-account-session.ts";
import type { TokenEstimationContext } from "./token-estimation-metrics.ts";
import { isLocalChatMode, type ChatMode } from "../core/config.ts";

export interface DirectStreamOptions {
  prompt: string;
  model: string;
  accountId: string;
  chatMode?: ChatMode;
  /** Budget for a human captcha solve when the upstream challenges us. */
  humanSolveTimeoutMs?: number;
  allowRecovery?: boolean;
  signal?: AbortSignal;
}

export interface DirectStreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  accountId: string;
  createdNewChat: boolean;
  tokenEstimationContext: TokenEstimationContext;
}

/** Thrown when the caller must fall back to the legacy transport. */
export class DirectTransportUnsupported extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`direct-transport-unsupported:${reason}`);
    this.name = "DirectTransportUnsupported";
    this.reason = reason;
  }
}

/** Thrown when the upstream refused; says whether a human solve was tried. */
export class DirectTransportWafBlocked extends Error {
  readonly recoveryAttempted: boolean;
  readonly recoverySucceeded: boolean;
  constructor(recoveryAttempted: boolean, recoverySucceeded: boolean) {
    super(
      recoverySucceeded
        ? "direct-transport-waf-retry-failed"
        : "direct-transport-waf-human-solve-required",
    );
    this.name = "DirectTransportWafBlocked";
    this.recoveryAttempted = recoveryAttempted;
    this.recoverySucceeded = recoverySucceeded;
  }
}

export function isDirectTransportEnabled(): boolean {
  return QWEN_DIRECT_WEB_TRANSPORT_ENABLED;
}

/**
 * Create a chat stream over the direct HTTP transport.
 *
 * The account's live cookie jar and JWT are read from its own browser page: the
 * account browser is the single source of session truth. That page is never
 * used to type, click, or intercept anything.
 */
export async function createDirectAccountStream(
  opts: DirectStreamOptions,
): Promise<DirectStreamResult> {
  if (!isDirectTransportEnabled()) {
    throw new DirectTransportUnsupported("feature-flag-disabled");
  }
  if (opts.signal?.aborted) {
    throw new Error("client aborted before direct stream creation");
  }
  if (!opts.prompt) throw new DirectTransportUnsupported("empty-prompt");

  const session = await captureAccountSession(opts.accountId, { force: true });
  if (!session) {
    // No live account page: fall back to the existing login/recovery machinery
    // rather than inventing a second login path here.
    throw new DirectTransportUnsupported("no-account-session");
  }
  if (!session.bearerToken) {
    throw new DirectTransportUnsupported("no-bearer-token");
  }
  if (!session.cookieHeader) {
    throw new DirectTransportUnsupported("no-cookie-jar");
  }
  if (opts.signal?.aborted) {
    throw new Error("client aborted before direct request");
  }

  const version = await getFrontendVersion().catch(() => null);
  // "local" is the upstream ephemeral chat mode; every other ChatMode value
  // maps to a normal (threaded) upstream chat.
  // Same mapping the legacy transport uses (qwen.ts:4562).
  const chatMode = isLocalChatMode(opts.chatMode) ? "local" : "normal";
  const accountId8 = opts.accountId.slice(0, 8);

  const createLeg = async (cookie: string): Promise<string | null> => {
    const created = await directCreateChat({
      cookie,
      model: opts.model,
      chatMode,
      chatType: "t2t",
      userAgent: session.userAgent,
      version,
      bearerToken: session.bearerToken,
      baxia: null,
    });
    if (!created.ok || !created.chatId) {
      console.warn(
        `⚠️ [DirectTransport] create_failed | account=${accountId8} | http=${created.httpStatus} | waf=${created.waf} | code=${created.errorCode ?? "-"}`,
      );
      return null;
    }
    return created.chatId;
  };

  const completeLeg = (cookie: string, chatId: string) =>
    directCompletionStream({
      cookie,
      bearerToken: session.bearerToken,
      chatId,
      model: opts.model,
      content: opts.prompt,
      chatMode,
      chatType: "t2t",
      userAgent: session.userAgent,
      version,
      baxia: null,
      signal: opts.signal,
    });

  // ── Leg 1 ────────────────────────────────────────────────────────────────
  let cookie = session.cookieHeader;
  let chatId = await createLeg(cookie);
  if (!chatId) throw new DirectTransportUnsupported("create-chat-failed");
  let result = await completeLeg(cookie, chatId);

  // ── At most ONE human-captcha recovery, always on a BRAND NEW chat ───────
  if (!result.ok && result.waf) {
    if (opts.allowRecovery === false || !opts.accountId) {
      invalidateX5sec(opts.accountId ?? "");
      throw new DirectTransportWafBlocked(false, false);
    }
    console.warn(
      `🚪 [DirectTransport] HUMAN_CAPTCHA_REQUIRED=YES | account=${accountId8} | CHALLENGE_OPENED=pending | challenge=${result.punishUrl ? "punish_url" : "none"}`,
    );
    // The clearance we were refused on is now known to be useless.
    invalidateX5sec(opts.accountId);
    const { recoverWithHumanCaptcha } = await import("./qwen-human-captcha.ts");
    const outcome = await recoverWithHumanCaptcha(opts.accountId, {
      // FULL body: the punish URL's x5secdata is truncated in any preview.
      challengeBody: result.challengeBody ?? "",
      timeoutMs: opts.humanSolveTimeoutMs,
    });
    if (!outcome.solved || !outcome.cookieHeader) {
      console.warn(
        `❌ [DirectTransport] human_solve_failed | account=${accountId8}`,
      );
      throw new DirectTransportWafBlocked(true, false);
    }
    cookie = outcome.cookieHeader;
    console.log(
      `✅ [HumanCaptcha] HUMAN_CAPTCHA_SOLVED=YES | account=${accountId8} | X5SEC_TTL_MS=${Math.round(outcome.x5secTtlMs)}`,
    );
    // NEW chat: the pre-solve chatId belongs to the pre-solve session.
    chatId = await createLeg(cookie);
    if (!chatId) throw new DirectTransportWafBlocked(true, true);
    result = await completeLeg(cookie, chatId);
    // A second challenge fails cleanly. No loop.
    if (!result.ok) throw new DirectTransportWafBlocked(true, true);
  }

  if (!result.ok || !result.stream) {
    throw new Error(
      `direct-completion-failed http=${result.httpStatus} ct=${result.contentType} waf=${result.waf}`,
    );
  }

  console.log(
    `⚡ [DirectTransport] stream_ready | account=${accountId8} | chat=${chatId.slice(0, 8)} | ct=${result.contentType}`,
  );

  return {
    stream: result.stream,
    headers: {},
    uiSessionId: chatId,
    accountId: opts.accountId,
    createdNewChat: true,
    tokenEstimationContext: {
      qwenPayloadBytes: Buffer.byteLength(opts.prompt, "utf-8"),
      qwenPayloadPromptChars: opts.prompt.length,
      qwenPayloadMessageCount: 1,
      activePersonalization: null,
    },
  };
}
