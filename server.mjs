#!/usr/bin/env node
// claude-api: a small local service that lets your own scripts and tools use
// Claude Code through the OpenAI and Anthropic API formats, so they work by
// changing only their base URL.
//
// Every request runs the official, unmodified `claude` CLI on this machine,
// signed in with your own account. Personal use only: your Pro/Max plan is
// for you, so don't serve other people's requests through it (see README).

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ALLOWED_ORIGINS, API_KEY, CLAUDE_CLI, DEFAULT_MODEL, DEFAULT_SYSTEM, HOST, MAX_CONCURRENT, MODELS, PORT, TOOLS,
} from "./lib/config.mjs";
import {
  HttpError, checkLogin, effortOf, liveStats, maxTurnsOf, modelOf, outputOf, resolveModel, runClaude, stats, toolServers, usageOf,
} from "./lib/claude.mjs";
import { anthropicErrorType, messages } from "./lib/anthropic.mjs";
import { chatCompletions } from "./lib/openai.mjs";
import { disconnectSignal, readJson, sendJson } from "./lib/http.mjs";

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
if (!LOOPBACK.includes(HOST) && !API_KEY) {
  console.error(`Refusing to listen on ${HOST} without API_KEY set. Set API_KEY, or keep HOST=127.0.0.1.`);
  process.exit(1);
}

// --- small routes ----------------------------------------------------------------

// Simplest possible endpoint: {"prompt": "...", "system"?: "...", "model"?: "..."}
async function ask(req, res) {
  const body = await readJson(req);
  if (!body.prompt || typeof body.prompt !== "string") throw new HttpError(400, 'Send JSON like {"prompt": "hi"}');
  const model = resolveModel(body.model);
  const result = await runClaude({
    system: body.system || DEFAULT_SYSTEM,
    content: [{ type: "text", text: body.prompt }],
    model,
    jsonSchema: body.json_schema || null,
    signal: disconnectSignal(res),
    mcpServers: toolServers(body.mcp_servers),
    maxTurns: maxTurnsOf(body.max_turns),
    effort: effortOf(body.effort),
  });
  const u = usageOf(result);
  sendJson(res, 200, {
    reply: outputOf(result),
    model: modelOf(result, model),
    usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output },
    duration_ms: result.duration_ms,
  });
}

// The Anthropic SDKs send an anthropic-version header and expect their own shape.
function models(req, res) {
  const ids = [...new Set([DEFAULT_MODEL, ...MODELS])];
  if (req.headers["anthropic-version"]) {
    const created_at = new Date().toISOString();
    return sendJson(res, 200, {
      data: ids.map((id) => ({ type: "model", id, display_name: id, created_at })),
      has_more: false,
      first_id: ids[0],
      last_id: ids.at(-1),
    });
  }
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "anthropic" })) });
}

const responses = {};
function statsReport(res) {
  sendJson(res, 200, {
    ...stats,
    ...liveStats(),
    uptime_seconds: Math.round(process.uptime()),
    responses,
  });
}

// --- HTTP plumbing -------------------------------------------------------------------

function authorized(req) {
  if (!API_KEY) return true;
  // OpenAI clients send `Authorization: Bearer`, Anthropic clients `x-api-key`.
  const key = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const given = Buffer.from(key);
  const expected = Buffer.from(API_KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendError(res, e, anthropic) {
  const status = e.status || 500;
  if (status !== 499) console.error(`[${status}] ${e.message}`);
  if (res.headersSent) return res.end();
  const type = e.type || "server_error";
  sendJson(
    res,
    status,
    anthropic
      ? { type: "error", error: { type: anthropicErrorType(type), message: e.message } }
      : { error: { message: e.message, type } },
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
  const started = Date.now();
  res.on("finish", () => {
    if (route === "GET /health") return;
    responses[res.statusCode] = (responses[res.statusCode] || 0) + 1;
    console.log(`${route} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try {
    if (route === "GET /health" || route === "GET ") {
      return sendJson(res, 200, { ok: true, default_model: DEFAULT_MODEL, tools: TOOLS || "none", ...liveStats() });
    }
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      throw new HttpError(403, `Requests from web pages (${origin}) are refused; add it to ALLOWED_ORIGINS to allow`, "permission_error");
    }
    if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    if (!authorized(req)) throw new HttpError(401, "Missing or invalid API key", "authentication_error");

    if (route === "POST /v1/chat/completions") await chatCompletions(req, res);
    else if (route === "POST /v1/messages") await messages(req, res);
    else if (route === "POST /ask") await ask(req, res);
    else if (route === "GET /v1/models") models(req, res);
    else if (route === "GET /stats") statsReport(res);
    else throw new HttpError(404, `No route for ${req.method} ${url.pathname}`, "not_found_error");
  } catch (e) {
    sendError(res, e, url.pathname.startsWith("/v1/messages"));
  }
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use — is claude-api already running? Set PORT to pick another.` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  console.log(banner(await checkLogin()));
});

// What to paste into your app, and anything that will stop requests working.
function banner(login) {
  const local = ["0.0.0.0", "::"].includes(HOST) ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  const url = `http://${local}:${PORT}`;
  const lines = [`claude-api listening on ${url}`];

  if (login?.missing) {
    lines.push(
      `  ⚠ Could not find "${CLAUDE_CLI}". Install Claude Code (https://docs.claude.com/en/docs/claude-code)`,
      "    or set CLAUDE_CLI to its full path. Requests will fail until then.",
    );
  } else if (login && !login.loggedIn) {
    lines.push("  ⚠ Claude Code isn't signed in. Run `claude`, type /login, then /exit — no restart needed.");
  } else if (login) {
    const plan = login.subscriptionType ? ` (${login.subscriptionType} plan)` : "";
    lines.push(`  Signed in to Claude${plan}${login.email ? ` as ${login.email}` : ""}`);
    if (/api.?key/i.test(login.authMethod || "")) {
      lines.push("  ⚠ Claude Code is using an API key, so requests are billed per token, not to your subscription.");
    }
  }

  lines.push(
    "",
    `  OpenAI SDKs      base_url = ${url}/v1`,
    `  Anthropic SDKs   base_url = ${url}`,
    `  api_key          ${API_KEY ? "your API_KEY from .env" : "any value (no API_KEY set)"}`,
    "",
    `  Try it:  curl -s ${url}/ask -H 'Content-Type: application/json'${API_KEY ? ` -H "Authorization: Bearer $API_KEY"` : ""} -d '{"prompt": "hi"}'`,
    "",
    `  model=${DEFAULT_MODEL} tools=${TOOLS || "none"} concurrency=${MAX_CONCURRENT}`,
  );
  return lines.join("\n");
}
