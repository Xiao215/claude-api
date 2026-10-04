// Running the official `claude` CLI: one headless process per request.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CLI, DEFAULT_MODEL, EFFORT, EFFORTS, MAX_CONCURRENT, MODEL_ALIASES, MODELS, TIMEOUT_MS, TOOLS,
} from "./config.mjs";

export class HttpError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// Claude runs in an empty folder so it never sees your files; with TOOLS empty
// it can only reply.
const WORKDIR = path.join(tmpdir(), "claude-api-workdir");
mkdirSync(WORKDIR, { recursive: true });

// Nothing leaves this machine except the prompt and reply themselves: no usage
// metrics, error reports, feedback surveys or transcript uploads. With
// --no-session-persistence (below) no transcript is written to ~/.claude either.
const CLAUDE_ENV = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DO_NOT_TRACK: "1",
};
// Claude Code here always uses your claude.ai login. An exported API key would
// switch it to per-token billing, and an exported ANTHROPIC_BASE_URL (handy for
// pointing your SDKs at this service) would make it call itself.
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete CLAUDE_ENV[name];

// --- model and effort ------------------------------------------------------------

// Map whatever model name a client sends onto a Claude model, so clients that
// default to e.g. "gpt-4o" just work. Your MODEL_ALIASES come first.
export function resolveModel(requested) {
  if (!requested || typeof requested !== "string") return DEFAULT_MODEL;
  const m = requested.toLowerCase();
  if (MODEL_ALIASES.has(m)) return MODEL_ALIASES.get(m);
  if (m.startsWith("claude-")) return requested;
  for (const alias of MODELS) if (m.includes(alias)) return alias;
  if (/mini|nano|small|lite|flash/.test(m)) return "haiku";
  if (/^o\d|large|ultra|-pro\b/.test(m)) return "opus";
  return DEFAULT_MODEL;
}

export function effortOf(value) {
  if (value == null) return EFFORT;
  if (value === "minimal" || value === "none") return "low"; // OpenAI's names
  if (!EFFORTS.includes(value)) throw new HttpError(400, `effort must be one of ${EFFORTS.join(", ")}`);
  return value;
}

// --- tool servers ------------------------------------------------------------------

// Tool servers a caller may attach: MCP over HTTP on this machine only. A URL is
// all that's accepted — never a command to run — so a request can't make this
// service start arbitrary programs.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;
export function toolServers(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 4) throw new HttpError(400, "mcp_servers must be an array of at most 4");
  return list.map((m) => {
    if (!/^[a-z0-9_-]{1,32}$/i.test(m?.name || "")) throw new HttpError(400, "mcp_servers[].name must be 1-32 letters, digits, - or _");
    if (!LOOPBACK_URL.test(m?.url || "")) throw new HttpError(400, "mcp_servers[].url must be an http:// URL on localhost/127.0.0.1");
    return { name: m.name, url: m.url };
  });
}

export function maxTurnsOf(n) {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 40) throw new HttpError(400, "max_turns must be an integer from 1 to 40");
  return v;
}

// --- concurrency limit -------------------------------------------------------------

let running = 0;
const waiting = [];
async function acquire() {
  if (running < MAX_CONCURRENT) return void running++;
  await new Promise((resolve) => waiting.push(resolve));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

// --- stats ---------------------------------------------------------------------------

// Since startup, in memory only. `plan` is the latest plan usage the CLI
// reported (fraction of the 5-hour and weekly windows used).
export const stats = { started_at: new Date().toISOString(), requests: 0, errors: 0, tokens: {}, plan: null, last_error: null };

function recordUsage(result) {
  const model = modelOf(result, "unknown");
  const t = (stats.tokens[model] ??= { requests: 0, input_tokens: 0, output_tokens: 0 });
  const u = usageOf(result);
  t.requests++;
  t.input_tokens += u.input;
  t.output_tokens += u.output;
}

function recordPlan(info) {
  const windows = info.unifiedWindows || {};
  stats.plan = {
    status: info.status,
    updated_at: new Date().toISOString(),
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, w]) => [
        name,
        { used_percent: Math.round((w.utilization ?? 0) * 100), resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null },
      ]),
    ),
  };
}

export function liveStats() {
  return { running, queued: waiting.length };
}

// --- sign-in check -------------------------------------------------------------------

// Asks the CLI who it's signed in as, so a missing install or login shows up
// at startup instead of as a failed first request. Resolves with
// { missing: true }, `claude auth status` JSON ({ loggedIn, authMethod, ... }),
// or null when the CLI can't say (e.g. an older version).
export function checkLogin() {
  return new Promise((resolve) => {
    execFile(CLAUDE_CLI, ["auth", "status", "--json"], { env: CLAUDE_ENV, timeout: 15000 }, (err, stdout) => {
      if (err?.code === "ENOENT") return resolve({ missing: true });
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// --- running the CLI ---------------------------------------------------------------

// The built-in tools for one request: the configured ones, plus web search
// when the request asks for it.
function builtIns(webSearch) {
  const names = TOOLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (webSearch) names.push("WebSearch", "WebFetch");
  return [...new Set(names)].join(",");
}

function claudeArgs({ model, systemFile, partial, jsonSchema, mcpFile, mcpServers, maxTurns, effort, webSearch }) {
  const tools = builtIns(webSearch);
  const args = [
    "-p",
    "--input-format", "stream-json", // lets the prompt carry images
    "--output-format", "stream-json",
    "--verbose", // required by stream-json output
    "--model", model,
    "--system-prompt-file", systemFile,
    "--tools", tools,
    "--strict-mcp-config", // ignore your MCP servers
    "--setting-sources", "", // ignore your hooks/plugins/settings, for speed and isolation
    "--no-session-persistence",
  ];
  // Headless mode can't ask for permission, so the tools it may use are listed
  // up front: the configured built-ins, plus every tool of each attached server.
  const allowed = [tools, ...mcpServers.map((m) => `mcp__${m.name}`)].filter(Boolean);
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (effort) args.push("--effort", effort);
  if (partial) args.push("--include-partial-messages");
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

// Runs one request. `content` is the user message as Anthropic content blocks
// (text and images). Calls onEvent for each CLI event and resolves with the
// final `result` event. Kills the process on timeout or when `signal` aborts.
export async function runClaude({
  system, content, model, jsonSchema = null, signal, onEvent, partial = false,
  mcpServers = [], maxTurns = null, effort = EFFORT, webSearch = false,
}) {
  stats.requests++;
  await acquire();
  // A client that gave up while queued shouldn't cost anything.
  if (signal?.aborted) {
    release();
    throw new HttpError(499, "Client disconnected", "cancelled");
  }
  const id = randomUUID();
  const systemFile = path.join(WORKDIR, `system-${id}.txt`);
  writeFileSync(systemFile, system);
  const mcpFile = mcpServers.length ? path.join(WORKDIR, `mcp-${id}.json`) : null;
  if (mcpFile) {
    const mcp = Object.fromEntries(mcpServers.map((m) => [m.name, { type: "http", url: m.url }]));
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: mcp }));
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const args = claudeArgs({ model, systemFile, partial, jsonSchema, mcpFile, mcpServers, maxTurns, effort, webSearch });
      const child = spawn(CLAUDE_CLI, args, { cwd: WORKDIR, env: CLAUDE_ENV, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let stderr = "";
      let result = null;
      let timedOut = false;
      let forceKill;
      const kill = () => {
        child.kill("SIGTERM");
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
      signal?.addEventListener("abort", kill, { once: true });

      const handle = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "result") result = event;
        if (event.type === "rate_limit_event" && event.rate_limit_info) recordPlan(event.rate_limit_info);
        onEvent?.(event);
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handle(line);
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.on("error", () => {}); // the CLI exited early; "close" reports why
      child.on("error", (e) =>
        reject(new HttpError(500, `Could not run "${CLAUDE_CLI}": ${e.message}`, "server_error")),
      );
      child.on("close", () => {
        clearTimeout(timer);
        clearTimeout(forceKill);
        signal?.removeEventListener("abort", kill);
        if (!result && buffer.trim()) handle(buffer.trim());
        if (signal?.aborted) return reject(new HttpError(499, "Client disconnected", "cancelled"));
        if (!result) {
          const why = timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s` : stderr.trim() || "The claude CLI exited without a result";
          return reject(new HttpError(timedOut ? 504 : 502, why, "server_error"));
        }
        if (result.subtype === "error_max_turns") {
          return reject(new HttpError(422, `Ran out of steps (max_turns ${maxTurns}) before finishing`, "max_turns_exceeded"));
        }
        if (result.is_error) return reject(claudeError(result.result || stderr.trim()));
        resolve(result);
      });

      child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    });
    recordUsage(result);
    return result;
  } catch (e) {
    if (e.status !== 499) {
      stats.errors++;
      stats.last_error = { at: new Date().toISOString(), status: e.status, message: e.message };
    }
    throw e;
  } finally {
    rmSync(systemFile, { force: true });
    if (mcpFile) rmSync(mcpFile, { force: true });
    release();
  }
}

function claudeError(message = "Claude returned an error") {
  if (/not logged in|\/login|invalid api key|oauth/i.test(message)) {
    return new HttpError(503, `${message} — run \`claude\` then /login on the host`, "authentication_error");
  }
  if (/usage limit|rate.?limit|hit your limit|limit reached|too many requests|overloaded/i.test(message)) {
    return new HttpError(429, message, "rate_limit_error");
  }
  return new HttpError(502, message, "server_error");
}

// --- reading the result --------------------------------------------------------------

export function usageOf(result) {
  const u = result.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return { input, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0 };
}

export function modelOf(result, fallback) {
  return Object.keys(result.modelUsage || {})[0] || fallback;
}

// The structured output when a JSON schema was given, else the reply text.
export function outputOf(result) {
  return result.structured_output !== undefined ? result.structured_output : (result.result ?? "");
}
