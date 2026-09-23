import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const SAMPLE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Execute bash command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

test("deep-coverage: recovers tool call missing opening bracket and quote (name\": ...)", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>name": "read", "arguments": {"path": "index.ts"}}</tool_call>';
  const res = parser.feed(raw);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "index.ts" });
});

test("deep-coverage: recovers tool call missing opening brace (\\\"name\\\": ...)", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>"name": "read", "arguments": {"path": "app.ts"}}</tool_call>';
  const res = parser.feed(raw);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "app.ts" });
});

test("deep-coverage: parses escaped JSON quotes (\\\"name\\\":...)", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>{\\"name\\": \\"write\\", \\"arguments\\": {\\"path\\": \\"test.txt\\", \\"content\\": \\"hello\\"}}</tool_call>';
  const res = parser.feed(raw);
  const flushed = parser.flush();
  const allCalls = [...res.toolCalls, ...flushed.toolCalls];

  assert.strictEqual(allCalls.length, 1);
  assert.strictEqual(allCalls[0].name, "write");
  assert.deepStrictEqual(allCalls[0].arguments, { path: "test.txt", content: "hello" });
});

test("deep-coverage: parses multiple tool calls across tags", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>{"name": "read", "arguments": {"path": "file1.txt"}}</tool_call><tool_call>{"name": "read", "arguments": {"path": "file2.txt"}}</tool_call>';
  const res = parser.feed(raw);
  const flushed = parser.flush();
  const allCalls = [...res.toolCalls, ...flushed.toolCalls];

  assert.strictEqual(allCalls.length, 2);
  assert.strictEqual(allCalls[0].name, "read");
  assert.deepStrictEqual(allCalls[0].arguments, { path: "file1.txt" });
  assert.strictEqual(allCalls[1].name, "read");
  assert.deepStrictEqual(allCalls[1].arguments, { path: "file2.txt" });
});

test("deep-coverage: recovers XML parameter tool calls with parameter tags", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call><parameter name="path">config.json</parameter><parameter name="content">{"ok":true}</parameter></tool_call>';
  const res = parser.feed(raw);
  const flushed = parser.flush();
  const allCalls = [...res.toolCalls, ...flushed.toolCalls];

  assert.strictEqual(allCalls.length, 1);
  assert.deepStrictEqual(allCalls[0].arguments, { path: "config.json", content: { ok: true } });
});

test("deep-coverage: handles ambiguous tool names normalizing to the same identifier", () => {
  const ambiguousTools = [
    { type: "function" as const, function: { name: "read_file" } },
    { type: "function" as const, function: { name: "READ_FILE" } },
  ];
  const parser = new StreamingToolParser(ambiguousTools as any);
  // Ambiguous name normalization marks the map entry empty to prevent inaccurate fuzzy matches
  assert.strictEqual((parser as any).resolveDeclaredToolName("READ_FILE"), "READ_FILE");
  assert.strictEqual((parser as any).resolveDeclaredToolName("read_file"), "read_file");
});

test("deep-coverage: flattens top-level arguments while ignoring reserved protocol keys", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>{"name": "read", "id": "call-abc-123", "type": "function", "tool": "read", "path": "server.ts"}</tool_call>';
  const res = parser.feed(raw);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "server.ts" });
});

test("deep-coverage: drops and tracks malformed XML with undeclared tool name", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call><parameter name="unknown_param">value</parameter></tool_call>';
  const res = parser.feed(raw);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 0);
  assert.strictEqual(parser.getMalformedToolCalls().length, 1);
});

test("deep-coverage: handles stringified jsonish arguments in tool call", () => {
  const parser = new StreamingToolParser(SAMPLE_TOOLS);
  const raw = '<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"nested.ts\\"}"}</tool_call>';
  const res = parser.feed(raw);
  parser.flush();

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "read");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "nested.ts" });
});
