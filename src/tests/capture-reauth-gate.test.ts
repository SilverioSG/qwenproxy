/**
 * Capture RCA: `executeReauth` confirmed a successful re-login with the FULL
 * `isPageLoggedIn`, whose first in-page statement fails closed on
 * `qwen_token_logged_out_marker` — a marker our own login sequence provokes
 * asynchronously. The result was the misleading
 * "Re-login ... did not restore an authenticated session" on a valid session,
 * which aborted the whole header capture with intercept_count=0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { probePageLoggedIn } from "../services/playwright.ts";

interface ProbeCall {
  url: string;
}

function makePage(opts: {
  marker?: boolean;
  settingsStatus?: number;
  settingsBody?: unknown;
} = {}) {
  const calls: ProbeCall[] = [];
  const ls: { token?: string; marker: boolean } = {
    token: "ls-token",
    marker: opts.marker === true,
  };
  const sandbox: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) =>
        k === "token"
          ? (ls.token ?? null)
          : k === "qwen_token_logged_out_marker" && ls.marker
            ? "1"
            : null,
      setItem: (k: string, v: string) => {
        if (k === "token") ls.token = v;
      },
      removeItem: (k: string) => {
        if (k === "token") delete ls.token;
      },
    },
    document: { cookie: "token=c" },
    fetch: async (input: string) => {
      calls.push({ url: String(input) });
      const status = opts.settingsStatus ?? 200;
      const body =
        opts.settingsBody ??
        ({ success: true, request_id: "r", data: { id: "u" } } as unknown);
      return { status, json: async () => body, text: async () => JSON.stringify(body) };
    },
    setTimeout,
    AbortSignal,
    JSON,
    Date,
    Object,
    Boolean,
    String,
  };
  const page = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    context: () => ({ cookies: async () => [{ name: "token", value: "c" }] }),
    evaluate: async (fn: unknown, arg?: unknown) => {
      const names = Object.keys(sandbox);
      const factory = new Function(...names, `return (${String(fn)});`) as (
        ...v: unknown[]
      ) => (a: unknown) => unknown;
      return factory(...names.map((n) => sandbox[n]))(arg) as Promise<unknown>;
    },
    calls,
    ls,
  };
  return page as typeof page & { evaluate: (fn: unknown, arg?: unknown) => Promise<unknown> };
}

/** The marker alone must not fail a non-mutating post-login validation. */
test("capture RCA: non-mutating validation ignores the logged-out marker", async () => {
  const page = makePage({ marker: true });
  const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
  assert.equal(r.reason, "ok");
});

/** The full probe keeps its previous fail-closed marker contract. */
test("capture RCA: full probe still fails closed on the marker", async () => {
  const page = makePage({ marker: true });
  const r = await probePageLoggedIn(page as never, 3000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "logged-out-marker");
  // It bails out before any subrequest.
  assert.equal(page.calls.length, 0);
});

/** A genuinely dead session still fails, marker or not. */
test("capture RCA: a real auth failure is still detected", async () => {
  for (const status of [401, 403]) {
    const page = makePage({ marker: true, settingsStatus: status });
    const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
    assert.equal(r.ok, false, `status ${status}`);
  }
  const page = makePage({
    marker: true,
    settingsStatus: 200,
    settingsBody: { success: false, data: { code: "Unauthorized" } },
  });
  const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "settings-revoked");
});

/** The confirmation after re-auth must be non-mutating. */
test("capture RCA: executeReauth confirms with the non-mutating probe", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("const executeReauth = async () => {");
  assert.ok(start >= 0, "executeReauth not found");
  const end = src.indexOf("if (forceReauth) {", start);
  const block = src.slice(start, end);
  assert.ok(
    block.includes("isPageLoggedIn(page, 5_000, { nonMutating: true })"),
    "re-auth confirmation must use the non-mutating probe",
  );
  assert.ok(
    !/isPageLoggedIn\(page, 5_000\)\)/.test(block),
    "the mutating confirmation must be gone from executeReauth",
  );
  // The misleading message survives, but only behind a real failed validation.
  assert.ok(block.includes("did not restore an authenticated session"));
  assert.ok(block.includes("if (!confirmed) {"));
});

/** No other post-login confirmation regressed to the full probe. */
test("capture RCA: the other full-probe gates are untouched", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  // captureQwenHeaders' guest detection still uses the full probe on attempt 2+.
  assert.ok(
    src.includes("attempt >= 2 && !(await isPageLoggedIn(page, 5000))"),
    "capture guest detection must keep the full probe",
  );
  assert.ok(src.includes("await isPageLoggedIn(page, 6000)"));
});

/** The probe reason is now observable in the tracer log. */
test("capture RCA: the probe reason is reported to the tracer", () => {
  const tracer = fs.readFileSync("src/services/session-tracer.ts", "utf-8");
  assert.ok(tracer.includes("reason=${isLoggedInReason || \"n/a\"}"));
  assert.ok(tracer.includes("isLoggedInReason = probeReason"));
  const pw = fs.readFileSync("src/services/playwright.ts", "utf-8");
  assert.ok(pw.includes("outcome.res, outcome.reason,"));
});

/** Non-mutating mode still performs exactly one read. */
test("capture RCA: non-mutating confirmation performs a single settings read", async () => {
  const page = makePage({ marker: true });
  await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(page.calls.length, 1);
  assert.ok(page.calls[0].url.includes("/api/v2/users/user/settings"));
  assert.equal(ls_isAbsent(page), false);
});

function ls_isAbsent(page: { ls: { token?: string } }): boolean {
  return !page.ls.token;
}
