/**
 * Transport dispatcher for chat stream creation.
 *
 * Chooses between the two proven transports WITHOUT changing any caller:
 *
 *   QWEN_DIRECT_WEB_TRANSPORT=false (default)
 *     -> legacy `createQwenStream` (browser page, composer, header capture).
 *        Behaviour is byte-for-byte what it was before this module existed,
 *        EXCEPT for in-scope requests on accounts with usable modern persisted
 *        auth (MODERN_PERSISTED_ACCOUNT_DIRECT_PATH): those go direct from
 *        ensureAccountFresh + the cold persisted bridge, with no browser.
 *        Legacy-only accounts are untouched.
 *
 *   QWEN_DIRECT_WEB_TRANSPORT=true
 *     -> direct HTTP account transport (Bearer + live cookie jar incl. the
 *        `x5sec` clearance), for the request shapes it fully supports.
 *
 * The direct path is only used for requests it can serve COMPLETELY. Anything
 * outside that scope — files, thread-native continuation, the auxiliary
 * title-only chat — falls back to the legacy transport, so enabling the flag
 * can never silently downgrade a feature to a text-only answer.
 *
 * The legacy `createQwenStream` is still imported and still the default: nothing
 * about the legacy path was removed.
 */

import { config, type ChatMode } from "../core/config.ts";
import { hasUsableModernPersistedAuth } from "../core/database.ts";
import type { QwenFileEntry } from "./qwen.ts";

export interface DispatchArgs {
  prompt: string;
  isThinkingModel: boolean;
  model: string;
  threadParentId?: string | null;
  accountId?: string;
  files?: QwenFileEntry[];
  options?: {
    chatSessionId?: string | null;
    forceNewChat?: boolean;
    reasoningMode?: "auto" | "thinking" | "fast";
    parallelEscape?: boolean;
    chatMode?: ChatMode;
  };
  signal?: AbortSignal;
  /**
   * Forwarded to the direct transport: fired once when human captcha
   * recovery starts, so the request lifecycle can extend its attempt
   * deadline for the solve. Never fired otherwise.
   */
  onCaptchaStart?: (info: { budgetMs: number }) => void;
}

export type StreamFactoryResult = Awaited<
  ReturnType<typeof import("./qwen.ts").createQwenStream>
>;

/**
 * Scope check, INDEPENDENT of the feature flag.
 *
 * Pure and exported so the supported request shapes are unit-testable without
 * having to flip global config. Returns null when the request is fully
 * supported, or a short reason when the legacy transport must own it.
 */
export function directTransportScopeReason(args: {
  accountId?: string;
  fileCount: number;
  threadParentId?: string | null;
  parallelEscape?: boolean;
  existingChatSessionId?: string | null;
}): string | null {
  if (!args.accountId || args.accountId === "global") {
    return "no-account-context";
  }
  if (args.fileCount > 0) return "files-unsupported";
  if (args.threadParentId) return "thread-continuation-unsupported";
  if (args.parallelEscape) return "auxiliary-chat-unsupported";
  if (args.existingChatSessionId) return "thread-native-unsupported";
  return null;
}

/** True when the direct transport is enabled AND the request is in its scope. */
export function shouldUseDirectTransport(args: {
  accountId?: string;
  fileCount: number;
  threadParentId?: string | null;
  parallelEscape?: boolean;
  useThreadNative?: boolean;
  existingChatSessionId?: string | null;
}): { use: boolean; reason: string } {
  const scope = directTransportScopeReason(args);
  if (scope) {
    return { use: false, reason: scope };
  }
  if (config.qwen.directWebTransport) {
    return { use: true, reason: "in-scope" };
  }
  // MODERN_PERSISTED_ACCOUNT_DIRECT_PATH: without the global flag, an
  // in-scope request on an account with usable modern persisted auth still
  // goes direct — it is served from ensureAccountFresh + the cold persisted
  // bridge with no browser. Legacy-only accounts keep the legacy transport.
  if (args.accountId && hasUsableModernPersistedAuth(args.accountId)) {
    return { use: true, reason: "modern-persisted" };
  }
  return { use: false, reason: "flag-disabled" };
}

/**
 * Create the chat stream with whichever transport is configured.
 *
 * `createLegacy` is injected by the caller so this module never forces the
 * heavy `qwen.ts` import graph into the direct path.
 */
export async function createStreamForAccount(
  args: DispatchArgs,
  createLegacy: () => Promise<StreamFactoryResult>,
): Promise<StreamFactoryResult> {
  const decision = shouldUseDirectTransport({
    accountId: args.accountId,
    fileCount: args.files?.length ?? 0,
    threadParentId: args.threadParentId,
    parallelEscape: args.options?.parallelEscape,
    existingChatSessionId: args.options?.chatSessionId ?? null,
  });

  if (!decision.use) {
    return createLegacy();
  }

  const { createDirectAccountStream, DirectTransportUnsupported } =
    await import("./qwen-direct-stream.ts");
  try {
    const direct = await createDirectAccountStream({
      prompt: args.prompt,
      model: args.model,
      accountId: args.accountId as string,
      chatMode: args.options?.chatMode,
      signal: args.signal,
      modernPersisted: decision.reason === "modern-persisted",
      onCaptchaStart: args.onCaptchaStart,
    });
    return {
      stream: direct.stream,
      headers: direct.headers,
      uiSessionId: direct.uiSessionId,
      controller: new AbortController(),
      accountId: direct.accountId,
      createdNewChat: direct.createdNewChat,
      tokenEstimationContext: direct.tokenEstimationContext,
    };
  } catch (err) {
    if (err instanceof DirectTransportUnsupported) {
      // Out of scope or no usable session: the legacy transport owns this.
      console.warn(
        `↩️ [Transport] direct_unsupported | reason=${err.reason} | falling_back=legacy`,
      );
      return createLegacy();
    }
    throw err;
  }
}
