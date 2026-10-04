// Shared behaviour: auth, errors, safety checks, /ask, /v1/models, /stats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEY, useServer } from "./helpers.mjs";

const LOG = path.join(tmpdir(), `fake-claude-${process.pid}.log`);
writeFileSync(LOG, "");
const { base, post } = useServer(18787, { MAX_CONCURRENT: "1", FAKE_CLAUDE_LOG: LOG, MODEL_ALIASES: "my-model=opus",
  // Exported so SDKs reach this service — must never reach the CLI.
  ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:18787",
});
const chat = (body) => post("/v1/chat/completions", { messages: [{ role: "user", content: "x" }], ...body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("health needs no key", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test("rejects missing or wrong API key; accepts Bearer and x-api-key", async () => {
  const send = (headers) =>
    fetch(`${base}/ask`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: '{"prompt":"hi"}' });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ Authorization: "Bearer nope" })).status, 401);
  assert.equal((await send({ "x-api-key": "nope" })).status, 401);
  assert.equal((await send({ Authorization: `Bearer ${KEY}` })).status, 200);
  assert.equal((await send({ "x-api-key": KEY })).status, 200);
});

test("/ask simple endpoint", async () => {
  const j = await (await post("/ask", { prompt: "hi", system: "S", model: "opus", effort: "low" })).json();
  assert.match(j.reply, /model=opus effort=low .*system="S" prompt="hi"/);
  assert.equal(j.usage.total_tokens, 20);
});

test("Claude Code always uses the claude.ai login: ANTHROPIC_* variables aren't passed on", async () => {
  const j = await (await post("/ask", { prompt: "hi" })).json();
  assert.match(j.reply, /anthropic_env=\[\]/);
});

test("model names: Claude names pass through, others are mapped, MODEL_ALIASES win", async () => {
  const modelOf = async (model) => /model=(\S+)/.exec((await (await chat({ model })).json()).choices[0].message.content)[1];
  assert.equal(await modelOf("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(await modelOf("haiku"), "haiku");
  assert.equal(await modelOf("gpt-4o"), "sonnet");
  assert.equal(await modelOf("gpt-4o-mini"), "haiku");
  assert.equal(await modelOf("o3"), "opus");
  assert.equal(await modelOf("my-model"), "opus");
});

test("errors: signed-out CLI -> 503, usage limit -> 429, timeout -> 504, bad input -> 400", async () => {
  const login = await post("/ask", { prompt: "FAIL_LOGIN" });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error.message, /login/);
  const limit = await post("/ask", { prompt: "FAIL_LIMIT" });
  assert.equal(limit.status, 429);
  assert.equal((await limit.json()).error.type, "rate_limit_error");

  assert.equal((await post("/ask", { prompt: "SLOW" })).status, 504);
  assert.equal((await post("/ask", {})).status, 400);
  assert.equal((await post("/ask", { prompt: "x", effort: "turbo" })).status, 400);
  const notJson = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: "{oops",
  });
  assert.equal(notJson.status, 400);
  assert.equal((await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${KEY}` } })).status, 404);
});

test("a request abandoned while waiting in the queue never runs", async () => {
  const busy = post("/ask", { prompt: "SLOW" }); // holds the only slot until the 2s timeout
  await sleep(300);
  const controller = new AbortController();
  const queued = fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ prompt: "QUEUED_THEN_ABANDONED" }),
    signal: controller.signal,
  }).catch(() => {});
  await sleep(300);
  controller.abort();
  await queued;
  await busy;
  await sleep(500);
  assert.doesNotMatch(readFileSync(LOG, "utf8"), /QUEUED_THEN_ABANDONED/);
});

test("models list, in both formats", async () => {
  const auth = { Authorization: `Bearer ${KEY}` };
  const openai = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  assert.deepEqual(openai.data.map((m) => m.id), ["sonnet", "haiku", "opus", "fable"]);
  const anthropic = await (await fetch(`${base}/v1/models`, { headers: { ...auth, "anthropic-version": "2023-06-01" } })).json();
  assert.equal(anthropic.data[0].type, "model");
  assert.equal(anthropic.has_more, false);
});

test("/stats reports token totals and the plan usage the CLI last saw", async () => {
  await post("/ask", { prompt: "count me" });
  const j = await (await fetch(`${base}/stats`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  assert.ok(j.requests >= 1);
  assert.ok(j.tokens["claude-sonnet-test"].output_tokens >= 7);
  assert.equal(j.plan.windows.five_hour.used_percent, 7);
  assert.ok(j.responses["200"] >= 1);
  assert.equal((await fetch(`${base}/stats`)).status, 401);
});

test("mcp_servers: loopback URLs become an --mcp-config and are pre-approved; max_turns passes through", async () => {
  const j = await (
    await chat({ mcp_servers: [{ name: "finstore", url: "http://127.0.0.1:4700/api/ai/mcp/abc" }], max_turns: 7 })
  ).json();
  const content = j.choices[0].message.content;
  assert.match(content, /mcp=\{"mcpServers":\{"finstore":\{"type":"http","url":"http:\/\/127\.0\.0\.1:4700\/api\/ai\/mcp\/abc"\}\}\}/);
  assert.match(content, /allowed="mcp__finstore"/);
  assert.match(content, /turns="7"/);
});

test("mcp_servers: anything but a named loopback http URL is refused", async () => {
  const bad = [
    [{ name: "x", url: "http://evil.example.com/mcp" }],
    [{ name: "x", url: "https://127.0.0.1/mcp" }],
    [{ name: "x", command: "rm", args: ["-rf", "/"] }],
    [{ name: "bad name!", url: "http://127.0.0.1:1/" }],
    "nope",
  ];
  for (const mcp_servers of bad) {
    assert.equal((await chat({ mcp_servers })).status, 400, JSON.stringify(mcp_servers));
  }
  assert.equal((await chat({ max_turns: 0 })).status, 400);
});

test("requests from web pages are refused (no browser can spend your subscription)", async () => {
  assert.equal((await post("/ask", { prompt: "hi" }, { Origin: "https://evil.example.com" })).status, 403);
  const plain = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(plain.status, 415);
});
