/**
 * Legacy create-chat auth: /api/v2/chats/new must send the persisted Bearer.
 *
 * The reference client is cookie-only on this route, but the live jar can hold
 * a stale/rotated token (proven: 6 accounts answered 401 while DirectTransport
 * created chats with the same accounts). requestQwenTextInBrowser resolves
 * getPersistedBearerToken() outside the page and attaches it in-page, keeping
 * credentials:include and the live browser jar untouched.
 *
 * Deterministic: fake page + isolated test DB, no network, no real browser.
 * Secrets never printed: assertions compare against in-test constants only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteAuthSession, saveAuthSession } from "../core/database.ts";
import {
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} from "../services/playwright.ts";
import { requestQwenTextInBrowser } from "../services/qwen.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0";
const PERSISTED = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1LXBlcnNpc3RlZCJ9.sig";

let capturedHeaders: Record<string, string> | null = null;

function fakePage() {
  return {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    context: () => ({ cookies: async () => [] }),
    evaluate: async (fn: (arg: unknown) => Promise<unknown>, arg: unknown) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const prev = {
        fetch: g.fetch,
        localStorage: g.localStorage,
        document: g.document,
      };
      g.fetch = async (
        _url: string,
        init: { headers?: Record<string, string> },
      ) => {
        capturedHeaders = { ...(init?.headers ?? {}) };
        return new Response(
          JSON.stringify({ success: true, data: { id: "chat-1" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      g.localStorage = { getItem: () => null, setItem: () => {} };
      g.document = { cookie: "" };
      try {
        return await fn(arg);
      } finally {
        g.fetch = prev.fetch;
        g.localStorage = prev.localStorage;
        g.document = prev.document;
      }
    },
  };
}

function seed(id: string): void {
  deleteAuthSession(id);
  saveAuthSession(id, {
    cookie: `token=${PERSISTED}; cna=row-cna`,
    userAgent: UA,
    bxV: "2.5.37",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    capturedAt: Date.now(),
  });
}

function sentAuth(): string | undefined {
  return (
    capturedHeaders?.["Authorization"] ??
    capturedHeaders?.["authorization"] ??
    undefined
  );
}

test("legacy chats/new sends the persisted Bearer", async () => {
  const id = "legacy-create-auth-1";
  seed(id);
  registerPlaywrightAccountForTests(id, fakePage() as never, Date.now());
  try {
    capturedHeaders = null;
    const res = await requestQwenTextInBrowser(
      id,
      "POST",
      "/api/v2/chats/new",
      { cookie: "token=stale; cna=live", "user-agent": UA, "bx-v": "2.5.37" },
      "{}",
    );
    assert.equal(res.status, 200);
    assert.equal(sentAuth(), `Bearer ${PERSISTED}`);
  } finally {
    unregisterPlaywrightAccountForTests(id);
    deleteAuthSession(id);
  }
});

test("legacy chats/new keeps cookie-only when no persisted Bearer exists", async () => {
  const id = "legacy-create-auth-2";
  deleteAuthSession(id);
  registerPlaywrightAccountForTests(id, fakePage() as never, Date.now());
  try {
    capturedHeaders = null;
    const res = await requestQwenTextInBrowser(
      id,
      "POST",
      "/api/v2/chats/new",
      { cookie: "token=live-only; cna=live", "user-agent": UA, "bx-v": "2.5.37" },
      "{}",
    );
    assert.equal(res.status, 200);
    assert.equal(sentAuth(), undefined);
  } finally {
    unregisterPlaywrightAccountForTests(id);
    deleteAuthSession(id);
  }
});

test("settings keeps cookie-only (no persisted Bearer injected)", async () => {
  const id = "legacy-create-auth-3";
  seed(id);
  registerPlaywrightAccountForTests(id, fakePage() as never, Date.now());
  try {
    capturedHeaders = null;
    const res = await requestQwenTextInBrowser(
      id,
      "GET",
      "/api/v2/users/user/settings",
      { cookie: "token=stale; cna=live", "user-agent": UA, "bx-v": "2.5.37" },
      undefined,
    );
    assert.equal(res.status, 200);
    assert.equal(sentAuth(), undefined);
  } finally {
    unregisterPlaywrightAccountForTests(id);
    deleteAuthSession(id);
  }
});
