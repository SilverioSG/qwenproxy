/**
 * Post-login validation must be NON-MUTATING.
 *
 * `/api/v1/auths/` and `auth.qwen.ai/api/v2/auths/refresh` both rotate the
 * session cookie. Calling either right after installing a token makes the SPA
 * drop `localStorage.token` and set `qwen_token_logged_out_marker`, so the
 * probe invalidates the state it is verifying. `loginViaApi` therefore uses
 * the single settings read only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { probePageLoggedIn } from "../services/playwright.ts";

interface Call {
  url: string;
  method: string;
}

interface FakePage {
  isClosed: () => boolean;
  url: () => string;
  context: () => { cookies: () => Promise<Array<{ name: string; value: string }>> };
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  calls: Call[];
  setLocalStorage: (state: { token?: string; marker?: boolean }) => void;
  getLocalStorage: () => { token?: string; marker?: boolean };
  responses: Record<string, { status: number; body: unknown }>;
}

/** Runs the real in-page closure against a fake fetch/localStorage/document. */
function makePage(opts: {
  responses?: Record<string, { status: number; body: unknown }>;
  closed?: boolean;
  url?: string;
  ls?: { token?: string; marker?: boolean };
  cookies?: Array<{ name: string; value: string }>;
} = {}): FakePage {
  const ls: { token?: string; marker?: boolean } = { ...(opts.ls ?? {}) };
  const responses = opts.responses ?? {
    "/api/v2/users/user/settings": {
      status: 200,
      body: { success: true, request_id: "r1", data: { id: "u1" } },
    },
  };
  const page: FakePage = {
    isClosed: () => opts.closed === true,
    url: () => opts.url ?? "https://chat.qwen.ai/",
    calls: [],
    setLocalStorage: (s: { token?: string; marker?: boolean }) => {
      if (s.token !== undefined) ls.token = s.token;
      if (s.marker !== undefined) ls.marker = s.marker;
    },
    getLocalStorage: () => ({ ...ls }),
    responses,
    context: () => ({
      cookies: async () => opts.cookies ?? [{ name: "token", value: "cookie-token" }],
    }),
    evaluate: async (fn: unknown, arg?: unknown) => {
      const sandboxFetch = async (input: string, init?: { method?: string }) => {
        page.calls.push({ url: String(input), method: init?.method ?? "GET" });
        const key = Object.keys(responses).find((k) => String(input).includes(k));
        const r = key ? responses[key] : { status: 404, body: null };
        return {
          status: r.status,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body),
        };
      };
      const sandbox = {
        localStorage: {
          getItem: (k: string) =>
            k === "token" ? (ls.token ?? null) : k === "qwen_token_logged_out_marker" && ls.marker ? "1" : null,
          setItem: (k: string, v: string) => {
            if (k === "token") ls.token = v;
          },
          removeItem: (k: string) => {
            if (k === "token") delete ls.token;
          },
        },
        document: { cookie: "token=ls-visible-token" },
        fetch: sandboxFetch,
        setTimeout,
        AbortSignal,
        JSON,
        Date,
        Object,
        Boolean,
        String,
      };
      // Recompile the real in-page closure with the sandbox globals bound as
      // parameters, so the production code path is what actually runs.
      const names = Object.keys(sandbox);
      const factory = new Function(...names, `return (${String(fn)});`) as (
        ...vals: unknown[]
      ) => (a: unknown) => unknown;
      const call = factory(...names.map((n) => sandbox[n as keyof typeof sandbox]));
      return call(arg) as Promise<unknown>;
    },
  };
  return page;
}

const AUTHS = "/api/v1/auths/";
const REFRESH = "auth.qwen.ai/api/v2/auths/refresh";
const SETTINGS = "/api/v2/users/user/settings";

/** A. The non-mutating probe must not call /api/v1/auths/. */
test("A. non-mutating validation never calls /api/v1/auths/", async () => {
  const page = makePage();
  await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.ok(!page.calls.some((c) => c.url.includes(AUTHS)), page.calls.map((c) => c.url).join(","));
});

/** B. The non-mutating probe must not call the cross-origin refresh. */
test("B. non-mutating validation never calls refresh", async () => {
  const page = makePage();
  await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.ok(!page.calls.some((c) => c.url.includes(REFRESH)));
});

/** C. settings 200 + appFail=false -> validation=true. */
test("C. settings 200 + success -> ok", async () => {
  const page = makePage();
  const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
  assert.equal(page.calls.filter((c) => c.url.includes(SETTINGS)).length, 1);
});

/** D. settings 200 with appUnauthorized -> validation=false. */
test("D. settings 200 + appUnauthorized -> settings-revoked", async () => {
  const page = makePage({
    responses: {
      [SETTINGS]: {
        status: 200,
        body: { success: false, data: { code: "Unauthorized", details: "" } },
      },
    },
  });
  const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "settings-revoked");
});

/** E. settings 401/403 -> validation=false. */
test("E. settings 401 and 403 -> validation=false", async () => {
  for (const status of [401, 403]) {
    const page = makePage({ responses: { [SETTINGS]: { status, body: null } } });
    const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
    assert.equal(r.ok, false, `status ${status}`);
    assert.equal(r.reason, status === 401 ? "settings-401" : "settings-403");
  }
});

/** F. A closed page keeps the pre-existing contract. */
test("F. closed page -> page-closed, both modes", async () => {
  for (const opts of [{}, { nonMutating: true }]) {
    const page = makePage({ closed: true });
    const r = await probePageLoggedIn(page as never, 3000, opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "page-closed");
  }
  // An /auth URL is refused before any request, in both modes.
  for (const opts of [{}, { nonMutating: true }]) {
    const page = makePage({ url: "https://chat.qwen.ai/login" });
    const r = await probePageLoggedIn(page as never, 3000, opts);
    assert.equal(r.reason, "auth-url");
    assert.equal(page.calls.length, 0);
  }
});

/** G. loginViaApi still signs in, installs, reloads, then validates. */
test("G. loginViaApi validates with the non-mutating probe", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("async function loginViaApi");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 60_000);
  const signin = block.indexOf("auths/signin");
  const cookie = block.indexOf("addCookies");
  const lsWrite = block.indexOf('localStorage.setItem("token", tok)');
  const reload = block.indexOf(".reload(");
  const validate = block.indexOf("probePageLoggedIn(page, 3000, {");
  assert.ok(signin >= 0, "signin missing");
  assert.ok(cookie > signin, "cookie install must follow signin");
  assert.ok(lsWrite > cookie, "LS install must follow cookie install");
  assert.ok(reload > lsWrite, "reload must follow installs");
  assert.ok(validate > reload, "validation must follow reload");
  // The only non-mutating validation call in the whole file is this one.
  assert.equal((src.match(/probePageLoggedIn\(page, 3000, \{/g) ?? []).length, 1);
});

/** H/I. The probe performs exactly one read and mutates nothing in the page. */
test("H. localStorage.token survives the non-mutating validation", async () => {
  const page = makePage({ ls: { token: "ls-token" } });
  await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(page.getLocalStorage().token, "ls-token");
  assert.equal(page.getLocalStorage().marker, undefined);
});

test("I. the logged-out marker is not created by the non-mutating validation", async () => {
  const page = makePage({ ls: { token: "ls-token" } });
  const r = await probePageLoggedIn(page as never, 3000, { nonMutating: true });
  assert.equal(r.ok, true);
  assert.equal(page.getLocalStorage().marker, undefined);
  assert.equal(page.calls.filter((c) => c.url.includes(SETTINGS)).length, 1);
});

/** J. Every other isPageLoggedIn caller keeps the full (mutating) probe. */
test("J. other isPageLoggedIn callers keep the previous contract", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const prod = src.split("/**")[0] + src; // whole file
  const calls = [...prod.matchAll(/isPageLoggedIn\(\s*[A-Za-z_$][\w$]*\s*(?:,\s*[\d_]+\s*)?\)/g)];
  assert.ok(calls.length >= 7, `expected the legacy call sites, got ${calls.length}`);
  // Only the two post-login confirmations may pass an options object, and both
  // must be non-mutating: loginViaApi's post-install validation and the
  // executeReauth confirmation in refreshHeadersInternal.
  const withOptions = [...prod.matchAll(/isPageLoggedIn\([^)]*\{/g)];
  assert.equal(
    withOptions.length,
    2,
    "only the two post-login confirmations may pass options",
  );
  // One trace initializer + the two confirmation call sites.
  assert.equal([...prod.matchAll(/nonMutating: true/g)].length, 3);
  // And the full probe still calls auths + refresh.
  const start = prod.indexOf("export async function probePageLoggedIn");
  const end = prod.indexOf("export async function isPageLoggedIn", start);
  const probe = prod.slice(start, end);
  assert.ok(probe.includes('fetch("/api/v1/auths/"'), "full probe must keep auths");
  assert.ok(probe.includes("auth.qwen.ai/api/v2/auths/refresh"), "full probe must keep refresh");
});

/** The post-validation invariant is recorded as a tripwire, never a gate. */
test("post-validation invariant is recorded and never gates the login", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("async function loginViaApi");
  const block = src.slice(start, start + 60_000);
  const i = block.indexOf("pv.invariant =");
  assert.ok(i >= 0);
  const region = block.slice(i - 1200, i + 400);
  assert.ok(region.includes("pv.cookieRotated || pv.lsRemoved || pv.markerCreated"));
  assert.ok(region.includes('"VIOLATED"'));
  // A violation warns; it must not change the returned success value.
  assert.ok(region.includes("console.warn"));
  assert.ok(!/invariant\s*===\s*"VIOLATED"\s*\)\s*return/.test(region));
});
