// POST /v1/chat/completions
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG, parseSSE, useServer } from "./helpers.mjs";

const { post } = useServer(18788);
const chat = (body) => post("/v1/chat/completions", body);
const user = (content) => [{ role: "user", content }];
const WEATHER = {
  type: "function",
  function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
};

test("OpenAI response shape, system prompt, usage", async () => {
  const r = await chat({ model: "gpt-4o", messages: [{ role: "system", content: "Be terse." }, ...user("hello")] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, "chat.completion");
  assert.equal(j.model, "claude-sonnet-test");
  const content = j.choices[0].message.content;
  assert.match(content, /system="Be terse\."/);
  assert.match(content, /prompt="hello"/);
  assert.match(content, /tools=""/); // chat only by default
  assert.equal(j.choices[0].finish_reason, "stop");
  assert.deepEqual(j.usage, { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } });
});

test("multi-turn chats become a transcript; text parts are joined", async () => {
  const j = await (
    await chat({
      messages: [
        { role: "user", content: [{ type: "text", text: "my name is Xiao" }] },
        { role: "assistant", content: "Nice to meet you!" },
        { role: "user", content: "what's my name?" },
      ],
    })
  ).json();
  const content = j.choices[0].message.content;
  assert.match(content, /<user>\\nmy name is Xiao\\n<\/user>/);
  assert.match(content, /<assistant>\\nNice to meet you!/);
  assert.match(content, /system="You are a helpful assistant\."/);
});

test("images: data URLs reach Claude as image blocks; remote URLs are refused", async () => {
  const j = await (
    await chat({ messages: user([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }]) })
  ).json();
  assert.match(j.choices[0].message.content, /images=\["image\/png"\]/);
  const remote = await chat({ messages: user([{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }]) });
  assert.equal(remote.status, 400);
  const pdf = await chat({ messages: user([{ type: "image_url", image_url: { url: "data:application/pdf;base64,AAAA" } }]) });
  assert.equal(pdf.status, 400);
});

test("json_schema response_format returns structured JSON", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const j = await (await chat({ messages: user("x"), response_format: { type: "json_schema", json_schema: { name: "t", schema } } })).json();
  const parsed = JSON.parse(j.choices[0].message.content);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.schema, schema);
});

test("reasoning_effort becomes --effort", async () => {
  const j = await (await chat({ messages: user("x"), reasoning_effort: "high" })).json();
  assert.match(j.choices[0].message.content, /effort=high/);
  assert.equal((await chat({ messages: user("x"), reasoning_effort: "huge" })).status, 400);
});

test("tools: Claude may answer normally", async () => {
  const j = await (await chat({ messages: user("hello"), tools: [WEATHER] })).json();
  const choice = j.choices[0];
  assert.equal(choice.finish_reason, "stop");
  assert.equal(choice.message.tool_calls, undefined);
  assert.match(choice.message.content, /# Tools/);
  assert.match(choice.message.content, /## get_weather/);
});

test("tools: Claude's tool calls come back in OpenAI's tool_calls format", async () => {
  const j = await (await chat({ messages: user("CALL_TOOL weather in Paris?"), tools: [WEATHER] })).json();
  const choice = j.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, "Checking.");
  const [call] = choice.message.tool_calls;
  assert.match(call.id, /^call_/);
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "get_weather");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Paris" });
});

test("tools: tool_choice required / named / none", async () => {
  const required = await (await chat({ messages: user("hi"), tools: [WEATHER], tool_choice: "required" })).json();
  assert.equal(required.choices[0].finish_reason, "tool_calls");
  const named = await (
    await chat({ messages: user("hi"), tools: [WEATHER], tool_choice: { type: "function", function: { name: "get_weather" } } })
  ).json();
  assert.equal(named.choices[0].message.tool_calls[0].function.name, "get_weather");
  const none = await (await chat({ messages: user("CALL_TOOL"), tools: [WEATHER], tool_choice: "none" })).json();
  assert.equal(none.choices[0].finish_reason, "stop");
  assert.doesNotMatch(none.choices[0].message.content, /# Tools/);

  const unknown = await chat({ messages: user("hi"), tools: [WEATHER], tool_choice: { type: "function", function: { name: "nope" } } });
  assert.equal(unknown.status, 400);
  assert.equal((await chat({ messages: user("hi"), tools: [{}] })).status, 400);
  assert.equal((await chat({ messages: user("hi"), functions: [{ name: "f" }] })).status, 400);
});

test("tools with response_format json_schema: tools may be called, and the final reply is in the schema", async () => {
  const format = { type: "json_schema", json_schema: { name: "x", schema: { type: "object", properties: { ok: { type: "boolean" } } } } };
  const reply = await (await chat({ messages: user("hi"), tools: [WEATHER], response_format: format })).json();
  assert.equal(reply.choices[0].finish_reason, "stop");
  assert.equal(JSON.parse(reply.choices[0].message.content).ok, true);
  const call = await (await chat({ messages: user("CALL_TOOL"), tools: [WEATHER], response_format: format })).json();
  assert.equal(call.choices[0].finish_reason, "tool_calls");
  assert.equal(call.choices[0].message.tool_calls[0].function.name, "get_weather");
});

test("web_search_options turns on WebSearch and WebFetch for that request only", async () => {
  const j = await (await chat({ messages: user("hi"), web_search_options: {} })).json();
  assert.match(j.choices[0].message.content, /tools="WebSearch,WebFetch"/);
  const plain = await (await chat({ messages: user("hi") })).json();
  assert.match(plain.choices[0].message.content, /tools=""/);
});

test("tools: earlier calls and their results are part of the transcript", async () => {
  const j = await (
    await chat({
      tools: [WEATHER],
      messages: [
        ...user("weather in Paris?"),
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "18C, sunny" },
      ],
    })
  ).json();
  const content = j.choices[0].message.content;
  assert.match(content, /<tool_call id=\\"call_1\\" name=\\"get_weather\\">\{\\"city\\":\\"Paris\\"\}<\/tool_call>/);
  assert.match(content, /<tool_result id=\\"call_1\\">\\n18C, sunny\\n<\/tool_result>/);
});

test("streaming: SSE chunks rebuild the text, skip thinking/sub-agents, end with [DONE]", async () => {
  const r = await chat({ stream: true, stream_options: { include_usage: true }, messages: user("stream me") });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const events = parseSSE(await r.text()).map((e) => e.data);
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1);
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  assert.match(text, /prompt="stream me"/);
  assert.doesNotMatch(text, /SUBAGENT|hmm/);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[0].model, "claude-sonnet-test");
  assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === "stop"));
  assert.equal(chunks.at(-1).usage.total_tokens, 20);
});

test("streaming: tool calls arrive as a tool_calls delta", async () => {
  const r = await chat({ stream: true, messages: user("CALL_TOOL"), tools: [WEATHER] });
  const chunks = parseSSE(await r.text()).map((e) => e.data).slice(0, -1);
  const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, 0);
  assert.equal(calls[0].function.name, "get_weather");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("streaming: a failure after text has started is reported as an error chunk", async () => {
  const r = await chat({ stream: true, messages: user("FAIL_MIDSTREAM") });
  assert.equal(r.status, 200);
  const events = parseSSE(await r.text()).map((e) => e.data);
  assert.notEqual(events.at(-1), "[DONE]");
  assert.match(events.at(-1).error.message, /broke off/);
});

test("streaming: a failure before any text is a normal HTTP error", async () => {
  const r = await chat({ stream: true, messages: user("FAIL_LIMIT") });
  assert.equal(r.status, 429);
});
