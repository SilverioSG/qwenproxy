import test from "node:test";
import assert from "node:assert";
import { extractExplicitConversationKey } from "../routes/chat/validation.ts";
import { deriveSessionId } from "../utils/session-id.ts";

function createMockContext(headers: Record<string, string>): any {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] || headers[name] || undefined,
    },
  };
}

test("extractExplicitConversationKey extracts OpenCode x-session-id header", () => {
  const c = createMockContext({ "x-session-id": "ses_opencode_alpha_123" });
  const key = extractExplicitConversationKey(c, { model: "qwen3.8-max", messages: [] });
  assert.strictEqual(key, "ses_opencode_alpha_123");
});

test("extractExplicitConversationKey extracts OpenCode x-session-affinity header", () => {
  const c = createMockContext({ "x-session-affinity": "ses_opencode_beta_456" });
  const key = extractExplicitConversationKey(c, { model: "qwen3.8-max", messages: [] });
  assert.strictEqual(key, "ses_opencode_beta_456");
});

test("extractExplicitConversationKey extracts OpenAI Codex session-id header", () => {
  const c = createMockContext({ "session-id": "01a0b75a-5423-7a20-8750-402d75795bf8" });
  const key = extractExplicitConversationKey(c, { model: "qwen3.8-max", messages: [] });
  assert.strictEqual(key, "01a0b75a-5423-7a20-8750-402d75795bf8");
});

test("extractExplicitConversationKey extracts Claude Code x-claude-code-session-id header", () => {
  const c = createMockContext({ "x-claude-code-session-id": "f709d1ce-450c-4ee9-a594-6e3c08285a4c" });
  const key = extractExplicitConversationKey(c, { model: "qwen3.8-max", messages: [] });
  assert.strictEqual(key, "f709d1ce-450c-4ee9-a594-6e3c08285a4c");
});

test("extractExplicitConversationKey extracts Claude Code session_id from user_id metadata JSON", () => {
  const c = createMockContext({});
  const body = {
    model: "qwen3.8-max",
    messages: [],
    metadata: {
      user_id: JSON.stringify({ session_id: "claude-session-from-meta-999" }),
    },
  };
  const key = extractExplicitConversationKey(c, body as any);
  assert.strictEqual(key, "claude-session-from-meta-999");
});

test("native session headers prevent cross-project collisions for identical prompts", () => {
  const messages = [{ role: "user" as const, content: "ajuda no projeto" }];
  const genericSystem = "You are a coding assistant";

  // Project A, B, C with identical messages and identical system prompt
  const keyA = "ses_project_alpha";
  const keyB = "ses_project_beta";
  const keyC = "ses_project_gamma";

  const sessA = deriveSessionId(messages, genericSystem, keyA);
  const sessB = deriveSessionId(messages, genericSystem, keyB);
  const sessC = deriveSessionId(messages, genericSystem, keyC);

  assert.notStrictEqual(sessA, sessB, "Session A and B must never collide");
  assert.notStrictEqual(sessB, sessC, "Session B and C must never collide");
  assert.notStrictEqual(sessA, sessC, "Session A and C must never collide");

  // Subsequent turn of Project A with same key produces the EXACT same session ID
  const sessATurn2 = deriveSessionId(
    [...messages, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: "proximo passo" }],
    genericSystem,
    keyA,
  );
  assert.strictEqual(sessA, sessATurn2, "Turn 2 of Project A must reuse Project A session ID");
});
