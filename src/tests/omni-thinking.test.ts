import test from "node:test";
import assert from "node:assert";
import {
  getIncrementalDelta,
  isThinkingPhase,
  extractThinkingContent,
} from "../routes/chat/helpers.ts";

test("isThinkingPhase matches strictly verified Qwen thinking phases (think, thinking_summary)", () => {
  assert.strictEqual(isThinkingPhase("think"), true);
  assert.strictEqual(isThinkingPhase("thinking_summary"), true);

  assert.strictEqual(isThinkingPhase("answer"), false);
  assert.strictEqual(isThinkingPhase("thinking"), false);
  assert.strictEqual(isThinkingPhase("thought"), false);
  assert.strictEqual(isThinkingPhase("reasoning"), false);
  assert.strictEqual(isThinkingPhase(""), false);
  assert.strictEqual(isThinkingPhase(null), false);
  assert.strictEqual(isThinkingPhase(undefined), false);
});

test("extractThinkingContent extracts both direct content and structured summary", () => {
  // Direct content (omni models, think phase - verified in HAR)
  assert.strictEqual(
    extractThinkingContent({ phase: "think", content: "Direct reasoning" }),
    "Direct reasoning",
  );

  // Structured summary (thinking_summary phase - verified in HAR)
  assert.strictEqual(
    extractThinkingContent({
      phase: "thinking_summary",
      extra: {
        summary_title: { content: ["Step 1"] },
        summary_thought: { content: ["Thinking 1"] },
      },
    }),
    "**Step 1**\n\nThinking 1",
  );
});

test("phase: think deltas extract incremental reasoning chunks correctly", () => {
  const thinkChunks = [
    "Reflecting",
    " on",
    " the",
    " query",
    " about",
    " Pelé",
  ];

  let lastThinking = "";
  let lastThinkingLength = 0;
  let lastThinkingSuffix = "";
  let fullReasoning = "";

  for (const chunk of thinkChunks) {
    const result = getIncrementalDelta(
      lastThinking,
      chunk,
      lastThinkingLength,
      lastThinkingSuffix,
    );
    if (result.delta) {
      fullReasoning += result.delta;
      lastThinking = result.matchedContent;
      lastThinkingLength = result.contentLength;
      lastThinkingSuffix = result.contentSuffix;
    }
  }

  assert.equal(fullReasoning, "Reflecting on the query about Pelé");
});
