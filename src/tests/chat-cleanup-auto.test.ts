import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  enqueueOrphanChatDeletion,
  drainOrphanChatQueueForTests,
  cleanOldChatsForAccount,
  getOrphanQueueLengthForTests,
} from "../services/chat-cleanup.ts";
import { deleteSingleQwenChat } from "../services/qwen.ts";
import {
  updateLogicalThreadState,
  clearAllSessionsForAccount,
} from "../services/qwen-thread-state.ts";

test("deleteSingleQwenChat sends DELETE to specific chat endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenMethod = "";

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    seenUrl = typeof input === "string" ? input : input.url;
    seenMethod = init?.method || "GET";
    return new Response(
      JSON.stringify({ success: true, data: { status: true } }),
      { status: 200 },
    );
  };

  try {
    const ok = await deleteSingleQwenChat("mock-account", "chat-123");
    assert.strictEqual(ok, true);
    assert.strictEqual(seenUrl, "https://chat.qwen.ai/api/v2/chats/chat-123");
    assert.strictEqual(seenMethod, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enqueueOrphanChatDeletion enqueues and deletes chat when not in active session", async () => {
  const originalFetch = globalThis.fetch;
  const deletedChats: string[] = [];

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (init?.method === "DELETE" && url.includes("/api/v2/chats/")) {
      const parts = url.split("/");
      deletedChats.push(parts[parts.length - 1]);
      return new Response(
        JSON.stringify({ success: true, data: { status: true } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    enqueueOrphanChatDeletion("mock-account", "orphan-chat-999", "rate_limit");
    assert.strictEqual(getOrphanQueueLengthForTests() >= 1, true);

    await drainOrphanChatQueueForTests();
    assert.ok(deletedChats.includes("orphan-chat-999"));
    assert.strictEqual(getOrphanQueueLengthForTests(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enqueueOrphanChatDeletion does NOT delete a chat if it is actively bound to an ongoing session", async () => {
  const originalFetch = globalThis.fetch;
  const deletedChats: string[] = [];

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (init?.method === "DELETE" && url.includes("/api/v2/chats/")) {
      const parts = url.split("/");
      deletedChats.push(parts[parts.length - 1]);
      return new Response(
        JSON.stringify({ success: true, data: { status: true } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    // Bind active-chat-1 to an active session
    updateLogicalThreadState("session-active-1", {
      accountId: "mock-account",
      chatSessionId: "active-chat-1",
      parentId: "parent-1",
      instructionsSent: true,
    });

    enqueueOrphanChatDeletion("mock-account", "active-chat-1", "test_accidental_queue");
    await drainOrphanChatQueueForTests();

    assert.strictEqual(deletedChats.includes("active-chat-1"), false, "active chat must not be deleted");
  } finally {
    clearAllSessionsForAccount("mock-account");
    globalThis.fetch = originalFetch;
  }
});

test("cleanOldChatsForAccount deletes chats older than maxAgeHours and preserves recent and active chats", async () => {
  const originalFetch = globalThis.fetch;
  const deletedChats: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const twoDaysAgoSec = nowSec - 48 * 3600;
  const oneHourAgoSec = nowSec - 3600;

  // Mock remote chats
  const mockRemoteChats = [
    { id: "old-abandoned-1", title: "Old 1", updated_at: twoDaysAgoSec, created_at: twoDaysAgoSec },
    { id: "old-abandoned-2", title: "Old 2", updated_at: twoDaysAgoSec, created_at: twoDaysAgoSec },
    { id: "recent-chat-3", title: "Recent 3", updated_at: oneHourAgoSec, created_at: oneHourAgoSec },
    { id: "active-bound-4", title: "Active 4", updated_at: twoDaysAgoSec, created_at: twoDaysAgoSec },
  ];

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    if (method === "GET" && url.includes("/api/v2/chats")) {
      return new Response(JSON.stringify({ success: true, data: mockRemoteChats }), { status: 200 });
    }
    if (method === "DELETE" && url.includes("/api/v2/chats/")) {
      const parts = url.split("/");
      deletedChats.push(parts[parts.length - 1]);
      return new Response(JSON.stringify({ success: true, data: { status: true } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    // Bind active-bound-4 to an ongoing active session
    updateLogicalThreadState("session-active-4", {
      accountId: "mock-account-cleanup",
      chatSessionId: "active-bound-4",
      parentId: "parent-4",
      instructionsSent: true,
    });

    const cleanedCount = await cleanOldChatsForAccount("mock-account-cleanup", 24);
    assert.strictEqual(cleanedCount, 2);
    assert.ok(deletedChats.includes("old-abandoned-1"));
    assert.ok(deletedChats.includes("old-abandoned-2"));
    assert.strictEqual(deletedChats.includes("recent-chat-3"), false, "recent chat must not be deleted");
    assert.strictEqual(deletedChats.includes("active-bound-4"), false, "active bound chat must not be deleted");
  } finally {
    clearAllSessionsForAccount("mock-account-cleanup");
    globalThis.fetch = originalFetch;
  }
});
