/**
 * Composer probe: passive observation of the chat composer during a capture.
 * Guards the sanitization contract and the classification logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COMPOSER_INSTALL_FN,
  COMPOSER_SNAPSHOT_FN,
  COMPOSER_DRAIN_FN,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  probeComposerDuringCapture,
} from "../services/composer-probe.ts";

test("composer-probe: the probe never modifies the capture path", () => {
  const pw = fs.readFileSync("src/services/playwright.ts", "utf-8");
  // No composer probe hooks may live inside captureQwenHeaders.
  const start = pw.indexOf("export async function captureQwenHeaders");
  assert.ok(start >= 0);
  const end = pw.indexOf("export async function getQwenHeaders", start);
  const endFallback = end > start ? end : start + 80_000;
  const block = pw.slice(start, endFallback);
  assert.ok(
    !block.includes("composer-probe"),
    "captureQwenHeaders must not depend on the composer probe",
  );
  assert.ok(!block.includes("COMPOSER_INSTALL_FN"));
  // The generic observer lives only in the diagnostic module.
  const probe = fs.readFileSync("src/services/composer-probe.ts", "utf-8");
  assert.ok(probe.includes('page.on("request"') || probe.includes("page.on("));
});

test("composer-probe: in-page listeners cover the required event types", () => {
  for (const t of [
    "input",
    "change",
    "keydown",
    "keyup",
    "keypress",
    "click",
    "submit",
    "beforeinput",
  ]) {
    assert.ok(COMPOSER_INSTALL_FN.includes(`"${t}"`), `missing listener ${t}`);
  }
  assert.ok(COMPOSER_INSTALL_FN.includes("addEventListener"));
  // The dispose closure (installed with the collector) does the removal.
  assert.ok(COMPOSER_INSTALL_FN.includes("removeEventListener"));
  assert.ok(COMPOSER_INSTALL_FN.includes("__qwenComposerProbe = {"));
  assert.ok(COMPOSER_DRAIN_FN.includes("P.dispose[0]()"));
  assert.ok(COMPOSER_DRAIN_FN.includes("delete window.__qwenComposerProbe"));
  assert.ok(COMPOSER_SNAPSHOT_FN.includes("P.snap(args.label)"));
  // The event type list must be complete (quoted, in one array).
  const list = COMPOSER_INSTALL_FN.match(/const TYPES = \[(.*?)\];/);
  assert.ok(list, "TYPES array missing");
  for (const t of [
    "input",
    "change",
    "keydown",
    "keyup",
    "keypress",
    "click",
    "submit",
    "beforeinput",
  ]) {
    assert.ok(list[1].includes(`"${t}"`), `TYPES missing ${t}`);
  }
});

test("composer-probe: selectors match the ones the capture itself uses", () => {
  const pw = fs.readFileSync("src/services/playwright.ts", "utf-8");
  for (const sel of COMPOSER_SELECTORS) {
    assert.ok(pw.includes(sel), `capture no longer uses ${sel}`);
  }
  for (const sel of SEND_BUTTON_SELECTORS) {
    assert.ok(pw.includes(sel), `capture no longer uses ${sel}`);
  }
});

test("composer-probe: the in-page code records no text, only lengths", () => {
  const src = COMPOSER_INSTALL_FN + COMPOSER_SNAPSHOT_FN + COMPOSER_DRAIN_FN;
  // Value/message text must never be pushed into the record.
  assert.ok(src.includes("value.length"), "value length must be recorded");
  assert.ok(!/\.value\s*[,)]/.test(src), "raw textarea value must not be recorded");
  assert.ok(!/innerText|textContent/.test(src), "message text must not be recorded");
  assert.ok(!/outerHTML|innerHTML/.test(src), "HTML must not be recorded");
  // URL/title are bounded.
  assert.ok(src.includes("location.href.slice(0, 120)"));
  assert.ok(src.includes('(document.title || "").slice(0, 80)'));
});

test("composer-probe: __name guard stays PASS (array-literal helpers)", () => {
  const NESTED_FN_DECL =
    /(?:^|[\s;{])const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g;
  for (const [name, fn] of [
    ["COMPOSER_INSTALL_FN", COMPOSER_INSTALL_FN],
    ["COMPOSER_SNAPSHOT_FN", COMPOSER_SNAPSHOT_FN],
    ["COMPOSER_DRAIN_FN", COMPOSER_DRAIN_FN],
  ] as const) {
    assert.deepEqual(
      [...fn.matchAll(NESTED_FN_DECL)].map((m) => m[0].slice(0, 40)),
      [],
      `${name} has a named function expression`,
    );
    // No dynamic import inside an in-page closure.
    assert.ok(!/import\(["'`]/.test(fn), `${name} must not import`);
  }
});

test("composer-probe: a page with no live handles is reported, not thrown", async () => {
  const r = await probeComposerDuringCapture(
    "no-such-account-for-composer-probe",
    async () => {
      throw new Error("capture must not run");
    },
  );
  assert.equal(r.installed, false);
  assert.equal(r.error, "no-live-page");
  assert.equal(r.captureError, null);
  assert.equal(r.genericRequestCount, 0);
});

test("composer-probe: output shape carries no secret field names", async () => {
  const r = await probeComposerDuringCapture("nope", async () => {});
  const blob = JSON.stringify(r);
  assert.ok(!/cookie|authorization|password|eyJ/i.test(blob));
  // Post data is only ever a length + hash.
  assert.ok(!/postData\b/.test(blob));
});

test("composer-probe: the in-page closures are compiled, not passed as strings", () => {
  // Regression guard: a raw string is evaluated as an expression by
  // Playwright, so the install never runs and every snapshot comes back null.
  const src = fs.readFileSync("src/services/composer-probe.ts", "utf-8");
  assert.ok(src.includes("compileInPage"));
  for (const fn of [
    "COMPOSER_INSTALL_FN",
    "COMPOSER_SNAPSHOT_FN",
    "COMPOSER_DRAIN_FN",
  ]) {
    assert.ok(
      src.includes(`compileInPage<boolean>(${fn})`) ||
        src.includes(`compileInPage(${fn})`) ||
        src.includes(`compileInPage<DomEventRecord[] | null>(${fn})`),
      `${fn} must be compiled before evaluate`,
    );
  }
  assert.ok(!/evaluate\(\s*COMPOSER_/.test(src), "no raw string may reach evaluate");
});

test("composer-probe: compiled in-page closures actually run", () => {
  // Executes install/snapshot/drain against a minimal DOM + window stub and
  // asserts the collector persists on window and produces a real record.
  const listeners: string[] = [];
  const removed: string[] = [];
  const el = () => ({
    tagName: "TEXTAREA",
    disabled: false,
    readOnly: false,
    value: "x".repeat(7),
    className: "message-input-textarea",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  });
  const doc: Record<string, unknown> = {
    querySelector: () => el(),
    addEventListener: (t: string) => listeners.push(t),
    removeEventListener: (t: string) => removed.push(t),
    title: "Qwen",
  };
  const win: Record<string, unknown> = {
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  const mk = (source: string) =>
    new Function(
      "document",
      "window",
      "location",
      `return (${source});`,
    )(doc, win, { href: "https://chat.qwen.ai/" }) as (a?: unknown) => unknown;
  const install = mk(COMPOSER_INSTALL_FN) as (a: unknown) => Record<string, unknown>;
  const pre = install({ selectors: ["textarea", "button.send-button"] });
  assert.equal(pre.composerFound, true);
  assert.equal(pre.composerVisible, true);
  assert.equal(pre.composerEnabled, true);
  assert.equal(pre.composerValueLength, 7);
  assert.equal(pre.url, "https://chat.qwen.ai/");
  assert.equal(pre.at, "pre");
  assert.deepEqual(listeners, [
    "input",
    "change",
    "keydown",
    "keyup",
    "keypress",
    "click",
    "submit",
    "beforeinput",
  ]);
  // State must live on window so it survives across evaluate calls.
  assert.ok(win.__qwenComposerProbe);
  const snap = mk(COMPOSER_SNAPSHOT_FN) as (a: unknown) => Record<string, unknown>;
  const post = snap({ label: "after-100ms" });
  assert.equal(post.at, "after-100ms");
  assert.equal(post.composerFound, true);
  const drain = mk(COMPOSER_DRAIN_FN) as () => unknown[];
  assert.deepEqual(drain(), []);
  assert.equal(removed.length, 8);
  assert.equal(win.__qwenComposerProbe, undefined);
});

test("composer-probe: the collector is installed with addInitScript, not once", () => {
  // Regression guard: the capture navigates to chat.qwen.ai, which destroys the
  // JS context. A one-shot evaluate install is wiped along with its listeners.
  const src = fs.readFileSync("src/services/composer-probe.ts", "utf-8");
  assert.ok(src.includes("addInitScript"), "must install via addInitScript");
  assert.ok(
    !/installRaw = await page\.evaluate/.test(src),
    "no one-shot evaluate install",
  );
  assert.ok(COMPOSER_INSTALL_FN.includes("COMPOSER_SEL = args.selectors[0]"));
  assert.ok(
    COMPOSER_INSTALL_FN.includes("window.__qwenComposerProbe = {"),
    "collector is re-created per document",
  );
});

test("composer-probe: the collector is persisted on window, not per-evaluate state", () => {
  // Regression guard: page.evaluate serializes its argument per call, so an
  // object handed in from Node is a fresh copy and nothing would ever persist.
  assert.ok(COMPOSER_INSTALL_FN.includes("window.__qwenComposerProbe = {"));
  assert.ok(COMPOSER_SNAPSHOT_FN.includes("window.__qwenComposerProbe"));
  assert.ok(COMPOSER_DRAIN_FN.includes("window.__qwenComposerProbe"));
  assert.ok(COMPOSER_INSTALL_FN.includes("P.events") === false);
  assert.ok(COMPOSER_DRAIN_FN.includes("P.events"));
  const src = fs.readFileSync("src/services/composer-probe.ts", "utf-8");
  assert.ok(!/const out = \{ events/.test(src), "no per-call out object");
});
