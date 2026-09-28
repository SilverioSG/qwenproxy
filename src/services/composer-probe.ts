import { createHash } from "node:crypto";

/**
 * DIAGNOSTIC ONLY — passive observation of the real Qwen chat composer during a
 * single `captureQwenHeaders` run.
 *
 * Nothing in the capture path is modified: this module installs DOM listeners
 * and a generic request observer on the account's live page, runs the existing
 * capture, then reports sanitized evidence about what the composer did.
 *
 * It never records prompt text, message text, HTML or header/cookie values —
 * only tag/role, key names, value LENGTHS, booleans, hosts, paths and hashes.
 */

/** Mirrors the composer/send selectors the capture itself uses. */
export const COMPOSER_SELECTORS = [
  "textarea.message-input-textarea",
  "textarea[placeholder*='Ask' i]",
  "textarea[placeholder*='Pergunte' i]",
  "textarea",
];

export const SEND_BUTTON_SELECTORS = [
  ".message-input-right-button-send .send-button",
  ".message-input-right-button-send button",
  ".chat-prompt-send-button",
  "button.send-button",
  "button[aria-label*='Send' i]",
  "button[aria-label*='Enviar' i]",
  ".send-button-container button",
];

export interface ComposerState {
  at: string;
  composerFound: boolean;
  composerVisible: boolean;
  composerEnabled: boolean;
  composerDisabledAttr: boolean;
  composerAriaDisabled: string | null;
  composerReadonly: boolean;
  composerValueLength: number;
  sendButtonFound: boolean;
  sendButtonVisible: boolean;
  sendButtonEnabled: boolean;
  sendButtonDisabledAttr: boolean;
  sendButtonAriaDisabled: string | null;
  messageEchoVisible: boolean;
  stopButtonVisible: boolean;
  loadingIndicatorVisible: boolean;
  generatingMarkerVisible: boolean;
  errorBannerVisible: boolean;
  challengeMarkerVisible: boolean;
  url: string;
  title: string;
}

export interface DomEventRecord {
  type: string;
  targetTag: string;
  targetRole: string | null;
  key: string | null;
  defaultPrevented: boolean;
  isTrusted: boolean;
  valueLength: number | null;
  at: number;
}

export interface GenericRequest {
  method: string;
  host: string;
  path: string;
  resourceType: string;
  postDataLength: number;
  postDataHash: string | null;
  at: number;
}

export interface ComposerProbeResult {
  installed: boolean;
  error: string | null;
  bootDiag?: unknown;
  pre: ComposerState | null;
  post: ComposerState | null;
  afterSubmit: ComposerState[];
  events: DomEventRecord[];
  requests: GenericRequest[];
  genericRequestCount: number;
  genericPostCount: number;
  genericFetchXhrCount: number;
  completionLike: GenericRequest[];
  unexpectedChatPaths: string[];
  captureError: string | null;
}

/** In-page install: state probe + event recorder. Array-literal helpers only
 *  (esbuild keepNames wraps named function expressions in __name, which the
 *  page does not have — regression d3c7140). */
/**
 * Installed with `page.addInitScript`, so it re-runs on EVERY document. The
 * capture navigates to chat.qwen.ai after the probe starts, which destroys the
 * JS context; a probe installed once on the previous document is wiped along
 * with its listeners, which is why the first two runs recorded nothing.
 */
export const COMPOSER_INSTALL_FN = `
() => {
  try { window.__qwenBootRan = (window.__qwenBootRan || 0) + 1; } catch (e) {}
  // Selectors are baked in: relying on an init-script argument made the whole
  // boot throw in the page (silently) whenever the argument was not delivered,
  // which left the collector missing and every snapshot null.
  const COMPOSER_SEL = ${JSON.stringify(COMPOSER_SELECTORS.join(", "))};
  const SEND_SEL = ${JSON.stringify(SEND_BUTTON_SELECTORS.join(", "))};
  // Array literals, not consts: esbuild keepNames rewrites named function
  // expressions to __name(f, "f") and __name does not exist in the page.
  const VIS = [
    (el) => {
      if (!el) return false;
      try {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return (
          r.width > 0 && r.height > 0 &&
          st.visibility !== "hidden" && st.display !== "none" &&
          st.opacity !== "0"
        );
      } catch (e) {
        return false;
      }
    },
  ];
  const Q = [
    (sel) => {
      try { return document.querySelector(sel); } catch (e) { return null; }
    },
  ];
  const SNAP = [
    (label) => {
      const ta = Q[0](COMPOSER_SEL);
      const btn = Q[0](SEND_SEL);
      const bclass = btn && btn.className && typeof btn.className === "string"
        ? btn.className.slice(0, 160) : "";
      return {
        at: label,
        composerFound: !!ta,
        composerVisible: VIS[0](ta),
        composerEnabled: ta ? !ta.disabled : false,
        composerDisabledAttr: ta ? !!ta.disabled : false,
        composerAriaDisabled: ta ? ta.getAttribute("aria-disabled") : null,
        composerReadonly: ta ? !!ta.readOnly : false,
        composerValueLength: ta && typeof ta.value === "string" ? ta.value.length : 0,
        sendButtonFound: !!btn,
        sendButtonVisible: VIS[0](btn),
        sendButtonEnabled: btn ? !btn.disabled && !/disabled/.test(bclass) : false,
        sendButtonDisabledAttr: btn ? !!btn.disabled : false,
        sendButtonAriaDisabled: btn ? btn.getAttribute("aria-disabled") : null,
        sendButtonClass: bclass,
        sendButtonTag: btn ? btn.tagName : null,
        messageEchoVisible: !!Q[0]("[data-message-author='user'], .user-message, [class*='user-message']"),
        stopButtonVisible: !!Q[0]("button[aria-label*='Stop' i], .stop-button, [class*='stop-button']"),
        loadingIndicatorVisible: !!Q[0]("[class*='loading'], [class*='spinner'], [aria-busy='true']"),
        generatingMarkerVisible: !!Q[0]("[class*='generating'], [data-generating='true'], [class*='streaming']"),
        errorBannerVisible: !!Q[0]("[class*='error-banner'], [role='alert'], [class*='error-message']"),
        challengeMarkerVisible: !!Q[0]("[class*='captcha'], [id*='captcha'], [class*='punish'], [class*='challenge']"),
        url: location.href.slice(0, 120),
        title: (document.title || "").slice(0, 80),
      };
    },
  ];
  const EVENTS = [];
  const REC = [
    (ev) => {
      const t = ev.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : "unknown";
      let role = null;
      try { role = t && t.getAttribute ? t.getAttribute("role") : null; } catch (e) {}
      let vl = null;
      try {
        if (t && typeof t.value === "string") vl = t.value.length;
      } catch (e) {}
      let prevented = false;
      try { prevented = ev.defaultPrevented; } catch (e) {}
      EVENTS.push({
        type: ev.type,
        targetTag: tag,
        targetRole: role,
        key: ev.key || null,
        defaultPrevented: prevented,
        isTrusted: ev.isTrusted === true,
        valueLength: vl,
        at: Date.now(),
      });
      if (EVENTS.length > 400) EVENTS.splice(0, EVENTS.length - 400);
    },
  ];
  const TYPES = ["input","change","keydown","keyup","keypress","click","submit","beforeinput"];
  // The collector MUST live on window: page.evaluate arguments are serialized
  // per call, so an object handed in from Node is a fresh copy every time and
  // no listener state or recorded event would ever survive to the next call.
  try { if (window.__qwenComposerProbe) window.__qwenComposerProbe.dispose(); } catch (e) {}
  window.__qwenComposerProbe = {
    events: EVENTS,
    snap: SNAP[0],
    dispose: [
      () => { for (const ty of TYPES) document.removeEventListener(ty, REC[0], true); },
    ],
  };
  for (const ty of TYPES) {
    document.addEventListener(ty, REC[0], true);
  }
  return SNAP[0]("pre");
}
`;

/** Diagnostic: reports whether the boot ran and why it did not, if it did not. */
export const COMPOSER_BOOT_DIAG_FN = `
() => {
  let present = false;
  try { present = typeof window.__qwenComposerProbe === "object"; } catch (e) {}
  return {
    bootRan: (typeof window.__qwenBootRan === "number" ? window.__qwenBootRan : 0),
    present,
    hasSnap: (() => {
      try { return !!(window.__qwenComposerProbe && window.__qwenComposerProbe.snap); }
      catch (e) { return false; }
    })(),
    href: (() => { try { return String(location.href).slice(0, 100); } catch (e) { return "n/a"; } })(),
  };
}
`;

export const COMPOSER_SNAPSHOT_FN = `
(args) => {
  const P = window.__qwenComposerProbe;
  if (!P || typeof P.snap !== "function") return null;
  return P.snap(args.label);
}
`;

export const COMPOSER_DRAIN_FN = `
() => {
  const P = window.__qwenComposerProbe;
  if (!P) return null;
  const events = P.events.slice(-400);
  if (P.dispose && P.dispose[0]) P.dispose[0]();
  try { delete window.__qwenComposerProbe; } catch (e) {}
  return events;
}
`;

/**
 * Compile an in-page arrow source into a real function so Playwright
 * serializes and CALLS it. Passing the raw string makes Playwright evaluate it
 * as an expression (a function literal that is never invoked), which is why the
 * first composer run installed nothing and every snapshot came back null.
 */
function compileInPage<T>(source: string): (arg: unknown) => T {
  try {
    return new Function(`return (${source});`)() as (arg: unknown) => T;
  } catch {
    return () => null as unknown as T;
  }
}

const COMPLETION_PATH_RE =
  /\/(completions|chats\/[^/]+\/(completions|messages)|messages|generate|stream|graphql)/i;

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    // Strip ids so paths can be compared as families.
    return u.pathname.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "/:id",
    ).slice(0, 120);
  } catch {
    return "invalid";
  }
}

function hashOf(v: string | undefined | null): string | null {
  if (!v) return null;
  try {
    return createHash("sha256").update(v, "utf8").digest("hex").slice(0, 12);
  } catch {
    return "hash-error";
  }
}

function toComposerState(raw: unknown): ComposerState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    at: String(r.at ?? ""),
    composerFound: r.composerFound === true,
    composerVisible: r.composerVisible === true,
    composerEnabled: r.composerEnabled === true,
    composerDisabledAttr: r.composerDisabledAttr === true,
    composerAriaDisabled:
      r.composerAriaDisabled === null ? null : String(r.composerAriaDisabled),
    composerReadonly: r.composerReadonly === true,
    composerValueLength: Number(r.composerValueLength ?? 0),
    sendButtonFound: r.sendButtonFound === true,
    sendButtonVisible: r.sendButtonVisible === true,
    sendButtonEnabled: r.sendButtonEnabled === true,
    sendButtonDisabledAttr: r.sendButtonDisabledAttr === true,
    sendButtonAriaDisabled:
      r.sendButtonAriaDisabled === null ? null : String(r.sendButtonAriaDisabled),
    messageEchoVisible: r.messageEchoVisible === true,
    stopButtonVisible: r.stopButtonVisible === true,
    loadingIndicatorVisible: r.loadingIndicatorVisible === true,
    generatingMarkerVisible: r.generatingMarkerVisible === true,
    errorBannerVisible: r.errorBannerVisible === true,
    challengeMarkerVisible: r.challengeMarkerVisible === true,
    url: String(r.url ?? ""),
    title: String(r.title ?? ""),
  };
}

export interface ComposerProbeRun {
  composerFound: boolean;
  composerVisible: boolean;
  composerEnabled: boolean;
  composerDisabledAttr: boolean;
  composerAriaDisabled: string | null;
  composerReadonly: boolean;
  composerValueLength: number;
  sendButtonFound: boolean;
  sendButtonVisible: boolean;
  sendButtonEnabled: boolean;
  sendButtonDisabledAttr: boolean;
  sendButtonAriaDisabled: string | null;
  sendButtonClassHash: string | null;
  sendButtonTag: string | null;
  messageEchoVisible: boolean;
  stopButtonVisible: boolean;
  loadingIndicatorVisible: boolean;
  generatingMarkerVisible: boolean;
  errorBannerVisible: boolean;
  challengeMarkerVisible: boolean;
  url: string;
  title: string;
}

/**
 * Run one real `captureQwenHeaders` while passively observing the composer.
 * Returns sanitized evidence only.
 */
export async function probeComposerDuringCapture(
  accountId: string,
  runCapture: () => Promise<void>,
  postSubmitDelaysMs: number[] = [100, 500, 1500],
): Promise<ComposerProbeResult> {
  const empty: ComposerProbeResult = {
    installed: false,
    error: null,
    pre: null,
    post: null,
    afterSubmit: [],
    events: [],
    requests: [],
    genericRequestCount: 0,
    genericPostCount: 0,
    genericFetchXhrCount: 0,
    completionLike: [],
    unexpectedChatPaths: [],
    captureError: null,
  };
  const { getAccountPageSnapshotHandles } = await import("./playwright.ts");
  const handles = getAccountPageSnapshotHandles(accountId);
  if (!handles) {
    return { ...empty, error: "no-live-page" };
  }
  const page = handles.page as {
    evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
    on?: (ev: string, cb: (req: unknown) => void) => void;
    off?: (ev: string, cb: (req: unknown) => void) => void;
  };
  const requests: GenericRequest[] = [];
  const onRequest = (req: unknown): void => {
    try {
      const r = req as {
        method(): string;
        url(): string;
        resourceType(): string;
        postData(): string | null;
      };
      const url = r.url();
      const pd = r.postData();
      requests.push({
        method: r.method(),
        host: shortHost(url),
        path: pathOf(url),
        resourceType: r.resourceType(),
        postDataLength: pd ? pd.length : 0,
        postDataHash: pd ? hashOf(pd) : null,
        at: Date.now(),
      });
      if (requests.length > 400) requests.splice(0, requests.length - 400);
    } catch {
      // Observer must never break the capture.
    }
  };
  const page2 = handles.page as {
    addInitScript?: (fn: unknown, arg?: unknown) => Promise<void>;
  };
  try {
    const initScript = page2.addInitScript;
    if (typeof initScript !== "function") {
      return { ...empty, error: "addInitScript-unavailable" };
    }
    await initScript.call(handles.page, compileInPage(COMPOSER_INSTALL_FN));
  } catch (err) {
    return {
      ...empty,
      error: `install-failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    };
  }
  if (typeof page.on === "function") page.on("request", onRequest);

  const snap = async (label: string): Promise<ComposerState | null> => {
    try {
      const raw = await page.evaluate(compileInPage(COMPOSER_SNAPSHOT_FN), {
        label,
      } as unknown);
      return toComposerState(raw);
    } catch {
      return null;
    }
  };
  let bootDiag: unknown = null;
  try {
    bootDiag = await page.evaluate(compileInPage(COMPOSER_BOOT_DIAG_FN));
  } catch {
    bootDiag = { error: "boot-diag-evaluate-failed" };
  }
  const pre = await snap("pre");

  let captureError: string | null = null;
  try {
    await runCapture();
  } catch (err) {
    captureError =
      err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }
  const afterSubmit: ComposerState[] = [];
  for (const d of postSubmitDelaysMs) {
    await new Promise((r) => setTimeout(r, d));
    const s = await snap(`after-${d}ms`);
    if (s) afterSubmit.push(s);
  }
  const post = afterSubmit[afterSubmit.length - 1] ?? (await snap("post"));
  let drained: DomEventRecord[] = [];
  try {
    const raw = await page.evaluate(
      compileInPage<DomEventRecord[] | null>(COMPOSER_DRAIN_FN),
    );
    if (Array.isArray(raw)) drained = raw;
  } catch {
    // Best effort.
  }
  if (typeof page.off === "function") page.off("request", onRequest);

  const completionLike = requests.filter((r) =>
    COMPLETION_PATH_RE.test(r.path),
  );
  const chatPaths = [
    ...new Set(
      requests
        .filter((r) => r.path.startsWith("/api/"))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].slice(0, 40);
  return {
    installed: true,
    error: null,
    bootDiag,
    pre,
    post,
    afterSubmit,
    events: drained.slice(-200),
    requests: requests.slice(-200),
    genericRequestCount: requests.length,
    genericPostCount: requests.filter((r) => r.method === "POST").length,
    genericFetchXhrCount: requests.filter(
      (r) => r.resourceType === "fetch" || r.resourceType === "xhr",
    ).length,
    completionLike,
    unexpectedChatPaths: chatPaths,
    captureError,
  };
}

