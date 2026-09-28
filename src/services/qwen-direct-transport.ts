/**
 * DIRECT WEB TRANSPORT for chat.qwen.ai.
 *
 * Derived from three independent, currently-working implementations audited at
 * their real code (not their READMEs):
 *
 *  - smanx/qwen2api @ 54f7993 (core.js, scripts/baxia-token.js)
 *      * headless Chrome runs the REAL Baxia SDK and reads
 *        window.__baxia__.getFYModule() -> getUidToken()/getFYToken()/fyObj.ver
 *      * those become bx-umidtoken / bx-ua / bx-v, cached 25 min
 *      * chat transport is then PURE HTTP: no UI, no composer, no clicking
 *      * POST {base}/api/v2/chats/new              {chat_mode:'guest',...}
 *      * POST {base}/api/v2/chat/completions?chat_id=<id>
 *      * NO Authorization header; auth is the `token` cookie
 *      * headers: bx-ua, bx-umidtoken, bx-v, Cookie, Origin, Referer,
 *        source:web, version, User-Agent, Accept-Language, x-request-id
 *      * WAF: body containing aliyun_waf => IP blocked; rgv587 => risk control
 *        (retry with fresh anti-bot material)
 *
 *  - izaart95-jpg/Qwen-Free-Api @ 0423802 (main.js)
 *      * auth is the `token` COOKIE, NOT a Bearer header — verified there that
 *        "Authorization: Bearer alone -> WAF CAPTCHA punish page (HTTP 200
 *        text/html)" and "Cookie: token=<jwt> -> passes WAF"
 *      * `Version` is REQUIRED by /api/v2/chat/completions; without it the
 *        endpoint answers HTTP 200 JSON {"code":"Bad_Request"}
 *      * X-Request-Id + source required by /api/v2/chats/new
 *      * frontend version scraped from the homepage bundle path
 *        /qwenweb/qwen-chat-fe/<VERSION>/js/main.js, cached 30 min, with one
 *        self-heal retry when Qwen bumps it
 *      * WAF markers: text/html response, or RGV587|FAIL_SYS_USER_VALIDATE|
 *        punish|x5sec inside a JSON body
 *
 *  - encryptarun/qwen-api @ 9fcac52 — third confirmation that the Qwen web
 *    credential is localStorage "token" from chat.qwen.ai (their own Bearer is
 *    only their hosted-API gate).
 *
 * Architectural consequence: the browser is required ONLY to produce the real
 * Baxia anti-bot material. The chat transport itself is ordinary HTTP. That is
 * why captureQwenHeaders (UI typing / send button / request interception) is
 * NOT architecturally necessary for chat.
 */

import { config } from "../core/config.ts";
import {
  getDefaultQwenUserAgent,
  getQwenWebVersion,
  updateQwenWebVersion,
} from "./qwen-headers.ts";
import { qwenUrl, qwenOrigin } from "./qwen-url.ts";
import {
  getLastBaxiaMintDiagnostics,
  mintQwenBaxiaMaterial,
} from "./qwen-baxia-minter.ts";

export const QWEN_DIRECT_WEB_TRANSPORT_ENABLED =
  process.env.QWEN_DIRECT_WEB_TRANSPORT !== "false";

/** Anti-bot material TTL. qwen2api caches the SDK result for 25 minutes. */
export const BAXIA_CACHE_TTL_MS = 20 * 60 * 1000;
/** Frontend version TTL. Qwen-Free-Api caches the scrape for 30 minutes. */
export const VERSION_CACHE_TTL_MS = 30 * 60 * 1000;
/** qwen2api's hardcoded fallback when the SDK/browser is unavailable. */
export const BAXIA_VERSION_FALLBACK = "2.5.37";

/** Shape returned by the in-page Baxia probe. */
export interface BaxiaProbe {
  ready: boolean;
  uid?: string;
  fy?: string;
  ver?: string;
  /** Sanitized reason the probe is not ready yet. Never contains values. */
  diag?: {
    hasBaxia: boolean;
    baxiaKeys: string;
    hasGetFYModule: boolean;
    hasFyObj: boolean;
    getFYModuleErr: string;
    uidLen: number;
    uidPrefix: string;
    fyLen: number;
    verValue: string;
    href: string;
    scriptHosts: string;
  };
  err?: string;
}

/**
 * Compile an in-page source into a real function so Playwright serializes and
 * CALLS it. Passing the raw string makes Playwright evaluate it as an
 * expression (a function literal that is never invoked).
 */
function compileInPage<T>(source: string): (arg?: unknown) => T {
  try {
    return new Function(`return (${source});`)() as (arg?: unknown) => T;
  } catch {
    return () => null as unknown as T;
  }
}

export interface BaxiaMaterial {
  /** getFYToken() — sent as bx-ua. */
  bxUa: string;
  /** getUidToken() — T2gA... — sent as bx-umidtoken. */
  bxUmidToken: string;
  /** fyObj.ver when the SDK reports it, else the 2.5.37 constant. */
  bxV: string;
  /** document.cookie from the minting browser (guest flow: no token=). */
  cookie?: string;
  /** Whether the values came from the real SDK (vs a degraded fallback). */
  fromSdk: boolean;
  fetchedAt: number;
}

/**
 * Anti-bot material now comes exclusively from the DEDICATED minter
 * (src/services/qwen-baxia-minter.ts): a fresh, empty-profile, non-stealth
 * headless Chromium. The account page is never used — it does not expose
 * window.__baxia__ (verified), so the SDK cannot be harvested there.
 */
let lastBaxiaProbe: { reason: string } | null = null;

function toBaxiaMaterial(m: {
  bxUa: string;
  bxUmidtoken: string;
  bxV: string;
}): { bxUa: string; bxUmidToken: string; bxV: string; fromSdk: boolean; fetchedAt: number } {
  return {
    bxUa: m.bxUa,
    bxUmidToken: m.bxUmidtoken,
    bxV: m.bxV,
    fromSdk: true,
    fetchedAt: Date.now(),
  };
}

/** Sanitized readiness info for the last mint attempt. */
export function getLastBaxiaProbe(): { reason: string } | null {
  return lastBaxiaProbe;
}

export function _resetDirectTransportCachesForTests(): void {
  versionCache = null;
  versionFetchedAt = 0;
  versionInflight = null;
  lastBaxiaProbe = null;
}

/**
 * Anti-bot material for the direct transport: the guest cookie and the
 * bx-* triple minted together by the dedicated browser. Cached by the minter.
 */
export async function getBaxiaMaterial(
  _accountId?: string,
  opts: { force?: boolean } = {},
): Promise<BaxiaMaterial | null> {
  const m = await mintQwenBaxiaMaterial({ force: opts.force === true });
  if (!m) {
    const d = getLastBaxiaMintDiagnostics();
    lastBaxiaProbe = { reason: d?.reason || "unknown" };
    return null;
  }
  lastBaxiaProbe = { reason: "ok" };
  return {
    ...toBaxiaMaterial(m),
    cookie: m.cookie,
  };
}

let versionCache: string | null = null;
let versionFetchedAt = 0;
let versionInflight: Promise<string | null> | null = null;

/**
 * Frontend `version` header value.
 *
 * Qwen-Free-Api scrapes the homepage bundle path
 * `/qwenweb/qwen-chat-fe/<VERSION>/js/main.js`; qwen2api pins `0.2.83`. We do
 * the same scrape and fall back to the configured value, and we keep the
 * dynamic value in the shared store so every other call site benefits.
 */
export async function getFrontendVersion(
  opts: { force?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  if (!opts.force && versionCache && now - versionFetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache;
  }
  if (!versionInflight) {
    versionInflight = (async (): Promise<string | null> => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(qwenUrl("/"), {
            headers: {
              "User-Agent": getDirectUserAgent(),
              Accept: "text/html,application/xhtml+xml",
            },
            signal: controller.signal,
          });
          const html = await res.text();
          const m =
            html.match(/qwenweb\/qwen-chat-fe\/(\d+\.\d+\.\d+)/) ??
            html.match(/qwen-chat-fe\/(\d+\.\d+\.\d+)/);
          if (m && m[1]) {
            versionCache = m[1];
            versionFetchedAt = Date.now();
            updateQwenWebVersion(m[1]);
            return m[1];
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Keep whatever we have.
      }
      return null;
    })().finally(() => {
      versionInflight = null;
    });
  }
  const scraped = await versionInflight;
  return scraped || getQwenWebVersion();
}

function getDirectUserAgent(): string {
  return getDefaultQwenUserAgent();
}

export interface DirectHeaderInput {
  cookie: string;
  userAgent?: string;
  bxUa?: string | null;
  bxUmidToken?: string | null;
  bxV?: string | null;
  version?: string | null;
  chatSessionId?: string | null;
  referer?: string;
  acceptLanguage?: string;
  /** Guest flow: /c/guest referer and the reference's accept-language. */
  chatModeGuest?: boolean;
  extra?: Record<string, string>;
}

export function buildDirectQwenHeaders(input: DirectHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language":
      input.acceptLanguage ||
      (input.chatModeGuest ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9"),
    "Content-Type": "application/json",
    // Auth is the token COOKIE. A Bearer header is what triggers the Aliyun WAF
    // punish page (verified in Qwen-Free-Api), so it is never added here.
    Cookie: input.cookie,
    Origin: qwenOrigin(),
    Referer:
      input.referer ||
      (input.chatSessionId
        ? input.chatModeGuest
          ? qwenUrl("/c/guest")
          : qwenUrl(`/c/${encodeURIComponent(input.chatSessionId)}`)
        : input.chatModeGuest
          ? qwenUrl("/c/guest")
          : qwenUrl("/")),
    "User-Agent": input.userAgent || getDirectUserAgent(),
    "X-Request-Id": crypto.randomUUID(),
    "bx-v": input.bxV || BAXIA_VERSION_FALLBACK,
    source: "web",
    // REQUIRED by /api/v2/chat/completions (Qwen-Free-Api).
    version: input.version || getQwenWebVersion(),
    timezone: new Date().toString().split(" (")[0],
    "sec-ch-ua": '"Chromium";v="151", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...(input.extra ?? {}),
  };
  // qwen2api sends bx-ua/bx-umidtoken as headers on both chats/new and
  // completions, sourced from the real SDK.
  if (input.bxUa) headers["bx-ua"] = input.bxUa;
  if (input.bxUmidToken) headers["bx-umidtoken"] = input.bxUmidToken;
  return headers;
}

export function looksLikeWafChallenge(body: string, contentType = ""): boolean {
  if (/text\/html/i.test(contentType)) {
    if (/aliyun_waf|Access[_ ]?Verification|captcha|_____tmd_____|x5secdata|x5referer|punish/i.test(body)) {
      return true;
    }
    return false;
  }
  return /RGV587|FAIL_SYS_USER_VALIDATE|aliyun_waf|punish_|x5sec/i.test(body);
}

/**
 * Pull the WAF punish/challenge URL out of a response body. The body arrives
 * JSON-wrapped today (`{"ret":[...],"data":{"url":"https://…/_____tmd_____/punish?x5sec…"}}`)
 * but the upstream has also shipped HTML/attribute forms, so all three are
 * normalized before matching. Sanitized: only the URL is returned.
 */
export function extractPunishUrl(body: string): string | null {
  if (!body) return null;
  const normalized = body
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const m = normalized.match(
    /https?:\/\/[^\s"'`\\<>()]*(?:_____tmd_____|x5secdata=|\/punish)[^\s"'`\\<>()]*/i,
  );
  if (m && m[0]) {
    try {
      return new URL(m[0]).toString().slice(0, 400);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Risk-control code qwen2api retries on with fresh anti-bot material. */
export function isRiskControlled(body: string, code?: string | null): boolean {
  if (code && /rgv.?587/i.test(code)) return true;
  return /rgv.?587/i.test(body);
}

export interface DirectCreateChatResult {
  ok: boolean;
  httpStatus: number;
  appSuccess: boolean;
  chatId: string | null;
  waf: boolean;
  riskControlled: boolean;
  contentType: string;
  errorCode: string | null;
  bodyPreview: string;
}

export async function directCreateChat(input: {
  cookie: string;
  model: string;
  chatMode?: string;
  chatType?: string;
  userAgent?: string;
  baxia?: BaxiaMaterial | null;
  version?: string | null;
  timeoutMs?: number;
}): Promise<DirectCreateChatResult> {
  // The guest cookie is minted together with the anti-bot material; when the
  // caller supplies one, use it instead of the account cookie.
  const effectiveCookie = input.cookie || input.baxia?.cookie || "";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, input.timeoutMs ?? 25_000),
  );
  try {
    const res = await fetch(qwenUrl("/api/v2/chats/new"), {
      method: "POST",
      headers: buildDirectQwenHeaders({
        cookie: effectiveCookie,
        userAgent: input.userAgent,
        bxUa: input.baxia?.bxUa,
        bxUmidToken: input.baxia?.bxUmidToken,
        bxV: input.baxia?.bxV,
        version: input.version,
        referer: qwenUrl("/c/guest"),
        chatModeGuest: true,
      }),
      body: JSON.stringify({
        title: "",
        models: [input.model],
        chat_mode: input.chatMode || "normal",
        chat_type: input.chatType || "t2p",
        timestamp: Date.now(),
        project_id: "",
      }),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();
    const waf = looksLikeWafChallenge(raw, contentType);
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const appSuccess = json?.success === true;
    const chatId =
      json?.data?.id ?? json?.data?.chat_id ?? json?.chat_id ?? json?.id ?? null;
    return {
      ok: appSuccess && typeof chatId === "string" && chatId.length > 0,
      httpStatus: res.status,
      appSuccess,
      chatId: typeof chatId === "string" ? chatId : null,
      waf,
      riskControlled: isRiskControlled(raw, json?.data?.code ?? json?.code ?? null),
      contentType,
      errorCode: json?.data?.code ?? json?.code ?? null,
      bodyPreview: raw.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      appSuccess: false,
      chatId: null,
      waf: false,
      riskControlled: false,
      contentType: "",
      errorCode: null,
      bodyPreview: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DirectCompletionResult {
  ok: boolean;
  httpStatus: number;
  contentType: string;
  waf: boolean;
  /** The WAF punish/challenge URL to hand to the recovery coordinator. */
  punishUrl: string | null;
  sseStarted: boolean;
  sseDone: boolean;
  outputLength: number;
  bodyPreview: string;
  text: string;
}

/**
 * POST /api/v2/chat/completions?chat_id=<id> and consume the SSE stream.
 * Body shape follows qwen2api (the reference that actually works against the
 * current upstream) rather than any historical QwenProxy shape.
 */
export async function directCompletion(input: {
  cookie: string;
  chatId: string;
  model: string;
  content: string;
  chatMode?: string;
  chatType?: string;
  enableSearch?: boolean;
  thinkingEnabled?: boolean;
  userAgent?: string;
  baxia?: BaxiaMaterial | null;
  version?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<DirectCompletionResult> {
  const chatType = input.chatType || "t2p";
  const model = input.model;
  const fid = crypto.randomUUID();
  const body = JSON.stringify({
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: input.chatId,
    chatId: input.chatId,
    chat_mode: input.chatMode || "normal",
    model,
    parent_id: null,
    parentId: "",
    messages: [
      {
        id: null,
        fid,
        parentId: null,
        childrenIds: [crypto.randomUUID()],
        role: "user",
        content: input.content,
        user_action: "chat",
        files: [],
        timestamp: Date.now(),
        models: [model],
        model: "",
        chat_type: chatType,
        feature_config: {
          thinking_enabled: input.thinkingEnabled !== false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: true,
          thinking_mode: "Auto",
          thinking_format: "summary",
          auto_search: input.enableSearch === true,
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      },
    ],
    timestamp: Date.now(),
  });

  const effectiveCookie = input.cookie || input.baxia?.cookie || "";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, input.timeoutMs ?? 120_000),
  );
  try {
    const res = await fetch(
      qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(input.chatId)}`),
      {
        method: "POST",
        headers: buildDirectQwenHeaders({
          cookie: effectiveCookie,
          userAgent: input.userAgent,
          bxUa: input.baxia?.bxUa,
          bxUmidToken: input.baxia?.bxUmidToken,
          bxV: input.baxia?.bxV,
          version: input.version,
          chatSessionId: input.chatId,
          chatModeGuest: true,
          extra: { "x-accel-buffering": "no" },
        }),
        body,
        signal: controller.signal,
      },
    );
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      return {
        ok: false,
        httpStatus: res.status,
        contentType,
        waf: looksLikeWafChallenge(raw, contentType),
        punishUrl: extractPunishUrl(raw),
        sseStarted: false,
        sseDone: false,
        outputLength: 0,
        bodyPreview: raw.slice(0, 200),
        text: "",
      };
    }
    if (!/text\/event-stream/i.test(contentType)) {
      // JSON answer: either an app-level error or a non-streaming payload.
      const raw = await res.text().catch(() => "");
      const waf = looksLikeWafChallenge(raw, contentType);
      const punishUrl = extractPunishUrl(raw);
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      if (json && json.success === false) {
        return {
          ok: false,
          httpStatus: res.status,
          contentType,
          waf,
          punishUrl,
          sseStarted: false,
          sseDone: false,
          outputLength: 0,
          bodyPreview: raw.slice(0, 200),
          text: "",
        };
      }
      const text =
        json?.data?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.message?.content ??
        "";
      return {
        ok: Boolean(text),
        httpStatus: res.status,
        contentType,
        waf,
        punishUrl,
        sseStarted: false,
        sseDone: Boolean(text),
        outputLength: typeof text === "string" ? text.length : 0,
        bodyPreview: raw.slice(0, 200),
        text: typeof text === "string" ? text : "",
      };
    }

    // SSE: consume until DONE.
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        ok: false,
        httpStatus: res.status,
        contentType,
        waf: false,
        punishUrl: null,
        sseStarted: false,
        sseDone: false,
        outputLength: 0,
        bodyPreview: "no-body-reader",
        text: "",
      };
    }
    const decoder = new TextDecoder();
    const maxBytes = input.maxBytes ?? 512 * 1024;
    let buffer = "";
    let raw = "";
    let sseStarted = false;
    let sseDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      if (raw.length > maxBytes) break;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!payload) {
          idx = buffer.indexOf("\n\n");
          continue;
        }
        sseStarted = true;
        let obj: any = null;
        try {
          obj = JSON.parse(payload);
        } catch {
          obj = null;
        }
        if (!obj) continue;
        if (obj.type === "text" || obj.type === "thinking") {
          if (obj.data && typeof obj.data === "string") {
            // accumulate below
          }
        }
        const phase = obj.phase ?? obj.data?.phase ?? null;
        if (phase === "answer" || phase === "final_answer") sseStarted = true;
        if (phase === "done" || obj.type === "done") {
          sseDone = true;
          break;
        }
        idx = buffer.indexOf("\n\n");
      }
      if (sseDone) break;
    }
    const text = extractAnswerFromSse(raw);
    return {
      ok: sseStarted && text.length > 0,
      httpStatus: res.status,
      contentType,
      waf: false,
      punishUrl: null,
      sseStarted,
      sseDone,
      outputLength: text.length,
      bodyPreview: raw.slice(0, 200),
      text,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      contentType: "",
      waf: false,
      punishUrl: null,
      sseStarted: false,
      sseDone: false,
      outputLength: 0,
      bodyPreview: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      text: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal answer extraction from Qwen's SSE. Mirrors the shapes both working
 * references rely on: a `data:` JSON frame per delta, and an explicit
 * phase=done terminator.
 */
export function extractAnswerFromSse(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj: any = null;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const c of choices) {
      const delta = c?.delta?.content ?? c?.message?.content ?? null;
      if (typeof delta === "string" && delta.length > 0) out += delta;
    }
    const detail = obj.data?.choices;
    if (Array.isArray(detail)) {
      for (const c of detail) {
        const delta = c?.delta?.content ?? c?.message?.content ?? null;
        if (typeof delta === "string" && delta.length > 0) out += delta;
      }
    }
    const content = obj.data?.content;
    if (typeof content === "string" && content.length > 0) out += content;
  }
  return out;
}

// ── WAF recovery orchestration ─────────────────────────────────────────────

export interface DirectRunLeg {
  create: {
    http: number;
    appSuccess: boolean;
    ok: boolean;
    chatId: string | null;
    waf: boolean;
    riskControlled: boolean;
    errorCode: string | null;
  };
  completion: DirectCompletionResult | null;
}

export interface DirectWafRunResult {
  first: DirectRunLeg;
  recoveryAttempted: boolean;
  recoverySuccess: boolean;
  recoveryDurationMs: number;
  recoverySkipReason: string | null;
  postBaxiaReady: boolean;
  second: DirectRunLeg | null;
}

async function runLeg(args: {
  baxia: BaxiaMaterial | null;
  cookie: string;
  model: string;
  content: string;
  chatMode: string;
  chatType: string;
  version: string | null;
  timeoutMs: number;
}): Promise<DirectRunLeg> {
  const created = await directCreateChat({
    cookie: args.cookie,
    model: args.model,
    chatMode: args.chatMode,
    chatType: args.chatType,
    baxia: args.baxia,
    version: args.version,
  });
  let completion: DirectCompletionResult | null = null;
  if (created.ok && created.chatId) {
    completion = await directCompletion({
      cookie: args.cookie,
      chatId: created.chatId,
      model: args.model,
      content: args.content,
      chatMode: args.chatMode,
      chatType: args.chatType,
      baxia: args.baxia,
      version: args.version,
      timeoutMs: args.timeoutMs,
    });
  }
  return {
    create: {
      http: created.httpStatus,
      appSuccess: created.appSuccess,
      ok: created.ok,
      chatId: created.chatId,
      waf: created.waf,
      riskControlled: created.riskControlled,
      errorCode: created.errorCode,
    },
    completion,
  };
}

/**
 * create-chat -> completion, with AT MOST ONE WAF recovery.
 *
 * On FAIL_SYS_USER_VALIDATE / RGV587 / _____tmd_____/punish / x5sec it hands the
 * challenge body to the existing `recoverBaxiaCaptcha` coordinator (which runs
 * the slider in the ACCOUNT browser), then — only if that succeeded — discards
 * the anti-bot material, mints a fresh one from the dedicated minter, and runs a
 * BRAND NEW chat. The previous chatId is never reused and there are no loops.
 *
 * Browser separation is preserved: account browser = session/solve; dedicated
 * minter = anti-bot material only.
 */
export async function directChatWithWafRecovery(args: {
  accountId?: string;
  cookie: string;
  model: string;
  content: string;
  chatMode: string;
  chatType: string;
  version: string | null;
  baxia: BaxiaMaterial | null;
  timeoutMs?: number;
  allowRecovery?: boolean;
}): Promise<DirectWafRunResult> {
  const timeoutMs = args.timeoutMs ?? 90_000;
  const first = await runLeg({
    baxia: args.baxia,
    cookie: args.cookie,
    model: args.model,
    content: args.content,
    chatMode: args.chatMode,
    chatType: args.chatType,
    version: args.version,
    timeoutMs,
  });
  const comp = first.completion;
  const wafHit = Boolean(
    comp && (comp.waf === true || /RGV587|FAIL_SYS_USER_VALIDATE/i.test(comp.bodyPreview)),
  );
  if (!wafHit) {
    return {
      first,
      recoveryAttempted: false,
      recoverySuccess: false,
      recoveryDurationMs: 0,
      recoverySkipReason: null,
      postBaxiaReady: false,
      second: null,
    };
  }
  if (args.allowRecovery === false) {
    return {
      first,
      recoveryAttempted: false,
      recoverySuccess: false,
      recoveryDurationMs: 0,
      recoverySkipReason: "recovery-disabled-by-caller",
      postBaxiaReady: false,
      second: null,
    };
  }
  const startedAt = Date.now();
  let recoverySuccess = false;
  let recoverySkipReason: string | null = null;
  try {
    const { recoverBaxiaCaptcha } = await import("./captcha-coordinator.ts");
    // The challenge body carries the punish URL; the coordinator extracts and
    // validates it against the Qwen origin itself (same-origin only).
    recoverySuccess = await recoverBaxiaCaptcha(
      args.accountId,
      "direct-transport",
      { challengeBody: comp?.bodyPreview ?? "" },
    );
  } catch (e) {
    recoverySkipReason =
      e instanceof Error ? e.message.slice(0, 120) : "recovery-threw";
  }
  const recoveryDurationMs = Date.now() - startedAt;
  if (!recoverySuccess) {
    return {
      first,
      recoveryAttempted: true,
      recoverySuccess: false,
      recoveryDurationMs,
      recoverySkipReason: recoverySkipReason ?? "recovery-returned-false",
      postBaxiaReady: false,
      second: null,
    };
  }
  // Recovery cleared the challenge: the old token material is now suspect and
  // the old chatId belongs to a pre-recovery session. Fresh material, new chat.
  const { invalidateQwenBaxiaMaterial, mintQwenBaxiaMaterial } = await import(
    "./qwen-baxia-minter.ts"
  );
  invalidateQwenBaxiaMaterial();
  const fresh = await mintQwenBaxiaMaterial({ force: true });
  const postBaxia = fresh
    ? {
        ...toBaxiaMaterial(fresh),
        cookie: fresh.cookie,
      }
    : null;
  const second = await runLeg({
    baxia: postBaxia,
    cookie: args.cookie,
    model: args.model,
    content: args.content,
    chatMode: args.chatMode,
    chatType: args.chatType,
    version: args.version,
    timeoutMs,
  });
  return {
    first,
    recoveryAttempted: true,
    recoverySuccess: true,
    recoveryDurationMs,
    recoverySkipReason: null,
    postBaxiaReady: postBaxia !== null,
    second,
  };
}
