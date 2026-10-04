// POST /v1/messages
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, PNG, parseSSE, useServer } from "./helpers.mjs";

const { post } = useServer(18789);
// Sent the way the Anthropic SDKs send it.
const messages = (body) =>
  post("/v1/messages", { max_tokens: 1024, ...body }, { Authorization: "", "x-api-key": KEY, "anthropic-version": "2023-06-01" });
const user = (content) => [{ role: "user", content }];
const WEATHER = { name: "get_weather", description: "Weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } } } };

test("Anthropic response shape, system prompt, usage", async () => {
  const r = await messages({ model: "claude-haiku-4-5", system: "Be terse.", messages: user("hello") });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.id, /^msg_/);
  assert.equal(j.type, "message");
  assert.equal(j.role, "assistant");
  assert.equal(j.model, "claude-claude-haiku-4-5-test");
  assert.equal(j.stop_reason, "end_turn");
  assert.equal(j.content[0].type, "text");
  assert.match(j.content[0].text, /system="Be terse\." prompt="hello"/);
  assert.deepEqual(j.usage, { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 7 });
});

test("system as text blocks; images as base64 blocks", async () => {
  const j = await (
    await messages({
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      messages: user([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text", text: "what is it?" }]),
    })
  ).json();
  assert.match(j.content[0].text, /images=\["image\/png"\] .*system="A\\n\\nB"/);
  const url = await messages({ messages: user([{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }]) });
  assert.equal(url.status, 400);
});

test("tools: tool_use blocks and stop_reason tool_use", async () => {
  const j = await (await messages({ messages: user("CALL_TOOL"), tools: [WEATHER] })).json();
  assert.equal(j.stop_reason, "tool_use");
  assert.deepEqual(j.content[0], { type: "text", text: "Checking." });
  assert.equal(j.content[1].type, "tool_use");
  assert.match(j.content[1].id, /^toolu_/);
  assert.equal(j.content[1].name, "get_weather");
  assert.deepEqual(j.content[1].input, { city: "Paris" });

  const any = await (await messages({ messages: user("hi"), tools: [WEATHER], tool_choice: { type: "any" } })).json();
  assert.equal(any.stop_reason, "tool_use");
  const other = await messages({ messages: user("hi"), tools: [{ type: "code_execution_20250522", name: "code" }] });
  assert.equal(other.status, 400);
});

test("web_search and web_fetch server tools turn on WebSearch and WebFetch for that request only", async () => {
  const j = await (await messages({ messages: user("hi"), tools: [{ type: "web_search_20250305", name: "web_search" }] })).json();
  assert.match(j.content[0].text, /tools="WebSearch,WebFetch"/);
  // Not offered as a caller-run tool.
  assert.doesNotMatch(j.content[0].text, /## web_search/);
  const plain = await (await messages({ messages: user("hi") })).json();
  assert.match(plain.content[0].text, /tools=""/);
});

test("tools with an output format: the final reply is in the schema", async () => {
  const j = await (await messages({
    messages: user("hi"),
    tools: [WEATHER],
    output_config: { format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
  })).json();
  assert.equal(j.stop_reason, "end_turn");
  assert.equal(JSON.parse(j.content[0].text).ok, true);
});

test("tools: tool_use and tool_result history is part of the transcript", async () => {
  const j = await (
    await messages({
      tools: [WEATHER],
      messages: [
        ...user("weather?"),
        { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "18C" }], is_error: false }] },
      ],
    })
  ).json();
  const text = j.content[0].text;
  assert.match(text, /<tool_call id=\\"toolu_1\\" name=\\"get_weather\\">/);
  assert.match(text, /<tool_result id=\\"toolu_1\\">\\n18C\\n<\/tool_result>/);
});

// The real CLI only has StructuredOutput. Without being told, Claude calls the
// caller's tools directly, gets "No such tool available" and often gives up;
// a transcript asking for plain text makes it skip the structured output.
test("tools: Claude is told they aren't its own tools and to request them via StructuredOutput", async () => {
  const j = await (
    await messages({
      tools: [WEATHER],
      messages: [...user("weather?"), { role: "assistant", content: "Where?" }, ...user("Paris")],
    })
  ).json();
  const text = j.content[0].text;
  assert.match(text, /not in your own tool list.*never call them directly/);
  assert.match(text, /call StructuredOutput with type \\"tool_calls\\"/);
  assert.match(text, /## get_weather\\nWeather for a city/);
  assert.doesNotMatch(text, /text only/);
});

test("structured output via output_config.format", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const j = await (await messages({ messages: user("x"), output_config: { format: { type: "json_schema", schema } } })).json();
  assert.equal(JSON.parse(j.content[0].text).ok, true);
});

test("streaming: Anthropic event sequence", async () => {
  const r = await messages({ stream: true, messages: user("stream me") });
  assert.equal(r.status, 200);
  const events = parseSSE(await r.text());
  for (const e of events) assert.equal(e.event, e.data.type);
  const types = events.map((e) => e.event);
  assert.equal(types[0], "message_start");
  assert.equal(events[0].data.message.model, "claude-sonnet-test");
  assert.equal(types.at(-1), "message_stop");
  assert.equal(types.at(-2), "message_delta");
  const text = events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("");
  assert.match(text, /prompt="stream me"/);
  assert.doesNotMatch(text, /SUBAGENT|hmm/);
  assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");
});

test("streaming: tool_use blocks with input_json_delta", async () => {
  const r = await messages({ stream: true, messages: user("CALL_TOOL"), tools: [WEATHER] });
  const events = parseSSE(await r.text());
  const toolStart = events.find((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
  assert.equal(toolStart.data.content_block.name, "get_weather");
  const json = events.find((e) => e.data.delta?.type === "input_json_delta" && e.data.index === toolStart.data.index);
  assert.deepEqual(JSON.parse(json.data.delta.partial_json), { city: "Paris" });
  assert.equal(events.find((e) => e.event === "message_delta").data.delta.stop_reason, "tool_use");
});

test("errors use Anthropic's error shape", async () => {
  const bad = await messages({ messages: [] });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(await bad.json()), ["type", "error"]);
  const limit = await messages({ messages: user("FAIL_LIMIT") });
  assert.equal(limit.status, 429);
  assert.equal((await limit.json()).error.type, "rate_limit_error");
  const mid = parseSSE(await (await messages({ stream: true, messages: user("FAIL_MIDSTREAM") })).text());
  assert.equal(mid.at(-1).event, "error");
  assert.equal(mid.at(-1).data.error.type, "api_error");
});
