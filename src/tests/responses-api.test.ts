import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import {
  storeResponse,
  getResponseHistory,
  getStoredResponse,
  deleteStoredResponse,
} from "../routes/responses/state.ts";
import {
  createStreamState,
  processChatChunk,
  buildFinalOutput,
  buildFinalUsage,
} from "../routes/responses/streaming.ts";
import {
  responsesToChatCompletions,
  chatCompletionsToResponses,
} from "../routes/responses/adapter.ts";
import { validateResponsesRequest } from "../routes/responses/validation.ts";
import type { ResponsesResponse, ResponsesRequest } from "../routes/responses/types.ts";

test("Responses State: storeResponse, getResponseHistory, getStoredResponse, and deleteStoredResponse", () => {
  const responseId = "resp_test_state_1";
  const mockResponse: ResponsesResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "qwen3.7-plus",
    status: "completed" as const,
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello there!", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  const chatMessages = [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: "Hello there!" },
  ];

  // 1. Store
  storeResponse(responseId, mockResponse, chatMessages);

  // 2. Retrieve history
  const history = getResponseHistory(responseId);
  assert.ok(history);
  assert.equal(history?.length, 2);
  assert.equal(history?.[0].content, "Hello");

  // 3. Retrieve stored response
  const stored = getStoredResponse(responseId);
  assert.ok(stored);
  assert.equal(stored?.id, responseId);
  assert.equal(stored?.status, "completed");

  // 4. Non-existent returns null
  assert.equal(getResponseHistory("resp_non_existent"), null);
  assert.equal(getStoredResponse("resp_non_existent"), null);

  // 5. Delete stored response
  const deleted = deleteStoredResponse(responseId);
  assert.equal(deleted, true);
  assert.equal(getResponseHistory(responseId), null);
  assert.equal(getStoredResponse(responseId), null);
});

test("Responses Validation: validateResponsesRequest handles valid and invalid payloads", () => {
  // Invalid JSON object
  assert.equal(validateResponsesRequest(null).valid, false);
  assert.equal(validateResponsesRequest("string").valid, false);
  assert.equal(validateResponsesRequest([]).valid, false);

  // Missing model
  assert.equal(validateResponsesRequest({ input: "hi" }).valid, false);

  // Missing input
  assert.equal(validateResponsesRequest({ model: "qwen3.7-plus" }).valid, false);

  // Valid string input
  const validStr = validateResponsesRequest({
    model: "qwen3.7-plus",
    input: "Explain quantum physics",
    stream: true,
  });
  assert.equal(validStr.valid, true);
  assert.equal(validStr.data?.model, "qwen3.7-plus");
  assert.equal(validStr.data?.stream, true);

  // Valid array input with content parts
  const validArray = validateResponsesRequest({
    model: "qwen3.8-max",
    input: [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Look at this image" },
          { type: "input_image", image_url: "https://example.com/img.png" },
          { type: "input_file", file_url: "https://example.com/doc.pdf" },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    ],
  });
  assert.equal(validArray.valid, true);
  assert.equal(validArray.data?.tools?.length, 1);
});

test("Responses Adapter: responsesToChatCompletions converts input, reasoning, and tools", () => {
  const req: ResponsesRequest = {
    model: "qwen3.8-max",
    input: [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "What is 2+2?" },
    ],
    instructions: "Be brief and concise",
    reasoning: { effort: "high" },
    max_output_tokens: 100,
    temperature: 0.7,
    tools: [
      {
        type: "function",
        name: "calculate",
        description: "Calculator",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
    ],
  };

  const chatReq = responsesToChatCompletions(req);
  assert.equal(chatReq.model, "qwen3.8-max");
  assert.equal(chatReq.max_completion_tokens, 100);
  assert.equal(chatReq.temperature, 0.7);
  assert.equal(chatReq.reasoning_effort, "high");
  assert.equal(chatReq.tools?.length, 1);
  assert.equal(chatReq.tools?.[0].function.name, "calculate");

  // Verify instructions prepend to system messages
  assert.ok(chatReq.messages.some((m) => m.role === "system" && Boolean(m.content && m.content.includes("Be brief"))));
});

test("Responses Adapter: chatCompletionsToResponses maps assistant response and tool calls", () => {
  const chatResponse = {
    id: "chatcmpl-test-123",
    created: 1700000000,
    model: "qwen3.7-plus",
    object: "chat.completion" as const,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "The weather in Tokyo is sunny.",
          tool_calls: [
            {
              id: "call_abc123",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 15,
      total_tokens: 40,
    },
  };

  const converted = chatCompletionsToResponses(chatResponse, "qwen3.7-plus", {
    input: "Weather in Tokyo",
    model: "qwen3.7-plus",
  });
  assert.ok(converted.id.startsWith("resp_"));
  assert.equal(converted.status, "completed");
  assert.equal(converted.output.length, 2); // 1 message + 1 function_call

  const msgItem = converted.output[0];
  assert.equal(msgItem.type, "message");
  if (msgItem.type === "message") {
    assert.equal(msgItem.content[0].text, "The weather in Tokyo is sunny.");
  }

  const fnItem = converted.output[1];
  assert.equal(fnItem.type, "function_call");
  if (fnItem.type === "function_call") {
    assert.equal(fnItem.name, "get_weather");
    assert.equal(fnItem.call_id, "call_abc123");
  }
});

test("Responses Streaming: processes delta text, tool calls, and finalizes output", () => {
  const state = createStreamState("resp_stream_test", "qwen3.7-plus");

  // 1. Text chunk delta
  const textEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { content: "Hello " } }],
    },
    state,
  );
  assert.ok(textEvents.length > 0);
  assert.ok(textEvents.some((e) => e.type === "response.output_text.delta"));

  // 2. Reasoning chunk delta
  const reasonEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { reasoning_content: "Thinking step..." } }],
    },
    state,
  );
  assert.ok(reasonEvents.length > 0);

  // 3. Tool call delta
  const toolEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_tool_1",
                function: { name: "search", arguments: '{"q":' },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  assert.ok(toolEvents.length > 0);

  // 4. Usage chunk
  processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: {} }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 30,
        total_tokens: 80,
      },
    },
    state,
  );

  // 5. Finalize
  const finalOutput = buildFinalOutput(state);
  assert.ok(finalOutput.length >= 1);

  const finalUsage = buildFinalUsage(state, 30);
  assert.equal(finalUsage.input_tokens, 50);
  assert.equal(finalUsage.output_tokens, 30);
  assert.equal(finalUsage.total_tokens, 80);
});

test("Responses HTTP Endpoints: GET, POST, and DELETE via app.fetch", async () => {
  // 1. POST with invalid JSON
  let res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "INVALID_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 2. POST with missing model
  res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Hello" }),
    }),
  );
  assert.equal(res.status, 400);

  // 3. POST with non-existent previous_response_id
  res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        input: "Follow up",
        previous_response_id: "resp_missing_123",
      }),
    }),
  );
  assert.equal(res.status, 404);

  // 4. GET non-existent response
  res = await app.fetch(new Request("http://localhost/v1/responses/resp_404_not_found"));
  assert.equal(res.status, 404);

  // 5. Store response and GET it
  const testId = "resp_endpoint_test_42";
  storeResponse(
    testId,
    {
      id: testId,
      object: "response",
      created_at: 1700000000,
      model: "qwen3.7-plus",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
    [{ role: "user", content: "test" }],
  );

  res = await app.fetch(new Request(`http://localhost/v1/responses/${testId}`));
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.id, testId);

  // 6. DELETE response
  res = await app.fetch(
    new Request(`http://localhost/v1/responses/${testId}`, { method: "DELETE" }),
  );
  assert.equal(res.status, 200);
  const delData = (await res.json()) as any;
  assert.equal(delData.deleted, true);

  // 7. GET after DELETE returns 404
  res = await app.fetch(new Request(`http://localhost/v1/responses/${testId}`));
  assert.equal(res.status, 404);
});
