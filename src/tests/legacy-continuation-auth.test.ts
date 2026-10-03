/**
 * Fix C: legacy continuation uses the proven modern session material.
 *
 * Contract:
 * - a legacy completion for an account with a usable persisted Bearer sends
 *   `Authorization` from that Bearer (not from a stale cached token cookie)
 *   and the jar's `token` pair aligned to it (pair coherence);
 * - `version` is always the configured chat-completions version (0.2.91),
 *   never a row value like 0.3.11/0.3.12 (proven live to 401 completions);
 * - without usable persisted material the previous mechanism stands
 *   (Bearer synthesized from the jar);
 * - the direct transport and the thread-reuse routing are untouched.
 *
 * Pure header construction + isolated test DB. No network, no browser.
 * Secrets never printed: assertions compare against in-test constants only
 * by equality, nothing is logged.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../core/config.ts";
import {
  deleteAuthSession,
  saveAuthSession,
} from "../core/database.ts";
import { buildCompletionHeaders } from "../services/qwen.ts";
import {
  buildDirectQwenHeaders,
} from "../services/qwen-direct-transport.ts";
import { directTransportScopeReason } from "../services/qwen-transport-dispatch.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0";
const PERSISTED_BEARER = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1LXB.new-token.sig";
const STALE_LIVE_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1LW9sZC1jb29raWUuc2ln";

function seedModern(id: string, rowVersion: string): void {
  deleteAuthSession(id);
  const expSec = Math.floor(Date.now() / 1000) + 3600;
  saveAuthSession(id, {
    cookie: `token=${PERSISTED_BEARER}; refresh_token=R-FIXC-1; cna=row-cna`,
    userAgent: UA,
    bxV: "2.5.37",
    bxUa: "",
    bxUmidtoken: "",
    version: rowVersion,
    tokenExpiresAt: expSec,
    capturedAt: Date.now(),
    refreshToken: "R-FIXC-1",
  });
}

/** Legacy input as getQwenHeaders would return it (stale cached material). */
function legacyInput() {
  return {
    cookie: `token=${STALE_LIVE_TOKEN}; cna=live-cna; x5sec=live-clearance`,
    "user-agent": UA,
    "bx-v": "2.5.37",
    "bx-ua": "",
    "bx-umidtoken": "",
    "sec-ch-ua": '"Chromium";v="153"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    version: "0.3.11",
  };
}

function cleanup(id: string): void {
  try {
    deleteAuthSession(id);
  } catch {}
}

test("legacy continuation uses the persisted Bearer, aligns the pair, pins version", () => {
  const id = "fixc-acc-1";
  seedModern(id, "0.3.11");
  try {
    const out = buildCompletionHeaders(legacyInput(), "chat-abc123", id);
    // Authorization from the persisted modern Bearer, not the stale cookie.
    assert.equal(out["Authorization"], `Bearer ${PERSISTED_BEARER}`);
    // Version pinned to the configured chat-completions version.
    assert.equal(out["version"], config.qwen.webVersion);
    assert.notEqual(out["version"], "0.3.11");
    // Jar pair aligned (coherence), other cookies preserved.
    assert.ok(out["Cookie"].includes(`token=${PERSISTED_BEARER}`));
    assert.ok(!out["Cookie"].includes(STALE_LIVE_TOKEN));
    assert.ok(out["Cookie"].includes("cna=live-cna"));
    assert.ok(out["Cookie"].includes("x5sec=live-clearance"));
  } finally {
    cleanup(id);
  }
});

test("row version 0.3.12 is equally ignored on legacy continuation", () => {
  const id = "fixc-acc-2";
  seedModern(id, "0.3.12");
  try {
    const out = buildCompletionHeaders(legacyInput(), "chat-abc123", id);
    assert.equal(out["Authorization"], `Bearer ${PERSISTED_BEARER}`);
    assert.equal(out["version"], config.qwen.webVersion);
    assert.notEqual(out["version"], "0.3.12");
  } finally {
    cleanup(id);
  }
});

test("no usable persisted material: legacy fallback contract preserved", () => {
  const id = "fixc-acc-absent";
  cleanup(id);
  const out = buildCompletionHeaders(legacyInput(), "chat-abc123", id);
  // Previous mechanism: Bearer synthesized from the jar's own token cookie.
  assert.equal(out["Authorization"], `Bearer ${STALE_LIVE_TOKEN}`);
  // Jar untouched (no alignment source).
  assert.ok(out["Cookie"].includes(`token=${STALE_LIVE_TOKEN}`));
  assert.ok(out["Cookie"].includes("cna=live-cna"));
});

test("direct transport header contract unchanged", () => {
  const h = buildDirectQwenHeaders({
    cookie: "token=T; cna=1",
    userAgent: UA,
    version: "0.2.91",
    bearerToken: PERSISTED_BEARER,
    chatSessionId: "chat-1",
  });
  assert.equal(h["Authorization"], `Bearer ${PERSISTED_BEARER}`);
  assert.equal(h["version"], "0.2.91");
  assert.ok(h["Cookie"].includes("token=T"));
});

test("thread-reuse routing unchanged: continuation still goes legacy", () => {
  const base = {
    accountId: "fixc-acc-1",
    fileCount: 0,
    threadParentId: null as string | null,
    parallelEscape: false,
    existingChatSessionId: null as string | null,
  };
  assert.equal(
    directTransportScopeReason({ ...base, existingChatSessionId: "chat-abc123" }),
    "thread-native-unsupported",
  );
  assert.equal(
    directTransportScopeReason({ ...base, threadParentId: "parent-1" }),
    "thread-continuation-unsupported",
  );
  // Fresh chats stay in scope (no routing change for the direct path).
  assert.equal(directTransportScopeReason(base), null);
});
