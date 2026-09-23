import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const DECLARED_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "Agent",
      description: "Run subagent",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Bash",
      description: "Run shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Edit",
      description: "Edit file",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["file_path"],
      },
    },
  },
];

test("StreamingToolParser: recovers tool call where Qwen omitted the name property but provided command argument", () => {
  const parser = new StreamingToolParser(DECLARED_TOOLS);

  // Exact payload structure from logs where the model emitted {"arguments": {"command": "..."}} without "name"
  const rawPayload =
    '<tool_call>{"arguments": {"command": "echo \\"=== FULL HEADER AUDIT ===\\""}}</tool_call>';

  const result = parser.feed(rawPayload);
  parser.flush();

  assert.strictEqual(result.toolCalls.length, 1, "Must recover the tool call");
  assert.strictEqual(result.toolCalls[0].name, "Bash", "Must infer Bash from command argument");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    command: 'echo "=== FULL HEADER AUDIT ==="',
  });
  assert.strictEqual(parser.getMalformedToolCalls().length, 0, "Must not be tracked as malformed");
});

test("StreamingToolParser: recovers tool call with flattened command argument without name", () => {
  const parser = new StreamingToolParser(DECLARED_TOOLS);

  const rawPayload =
    '<tool_call>{"command": "git status"}</tool_call>';

  const result = parser.feed(rawPayload);
  parser.flush();

  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "Bash");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    command: "git status",
  });
});
