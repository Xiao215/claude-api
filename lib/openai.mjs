// POST /v1/chat/completions — the OpenAI chat format.

import { randomUUID } from "node:crypto";
import {
  HttpError, effortOf, maxTurnsOf, modelOf, outputOf, resolveModel, runClaude, toolServers, usageOf,
} from "./claude.mjs";
import { imageFromUrl, readToolReply, toClaudeInput, toolDef } from "./conversation.mjs";
import { disconnectSignal, eventStream, readJson, sendJson } from "./http.mjs";

export async function chatCompletions(req, res) {
  const body = await readJson(req);
  if (body.functions || body.function_call) {
    throw new HttpError(400, "The legacy `functions` parameter isn't supported — use `tools`");
  }
  const convo = { ...parseMessages(body.messages), tools: parseTools(body.tools), toolChoice: parseToolChoice(body) };
  const model = resolveModel(body.model);

  let jsonSchema = null;
  let jsonObject = false;
  const format = body.response_format;
  if (format?.type === "json_schema") {
    jsonSchema = format.json_schema?.schema;
    if (!jsonSchema) throw new HttpError(400, "response_format.json_schema.schema is required");
  } else if (format?.type === "json_object") {
    jsonObject = true;
  }
  // With tools too, the schema is the shape of the final reply, as on the real API.
  const input = toClaudeInput({ ...convo, replySchema: jsonSchema });
  const usingTools = Boolean(input.jsonSchema);
  if (jsonObject) input.system += "\n\nRespond with a single valid JSON object only — no prose, no code fences.";
  if (usingTools) jsonSchema = input.jsonSchema;

  const request = {
    system: input.system,
    content: input.content,
    model,
    jsonSchema,
    signal: disconnectSignal(res),
    // Non-standard extensions: attach local MCP tool servers, cap the agent's turns.
    mcpServers: toolServers(body.mcp_servers),
    maxTurns: maxTurnsOf(body.max_turns),
    effort: effortOf(body.reasoning_effort),
    // OpenAI's per-request web search: Claude Code's WebSearch and WebFetch, for this request only.
    webSearch: body.web_search_options != null,
  };
  const run = (opts) => runClaude({ ...request, ...opts });
  const replyOf = (result) => {
    if (usingTools) return readToolReply(outputOf(result), "call_");
    const out = outputOf(result);
    return { text: typeof out === "string" ? out : JSON.stringify(out), calls: [] };
  };

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    const result = await run();
    const { text, calls } = replyOf(result);
    const message = { role: "assistant", content: calls.length && !text ? null : text };
    if (calls.length) message.tool_calls = calls.map(toOpenAICall);
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: modelOf(result, model),
      choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
      usage: openAIUsage(result),
    });
  }

  // Streaming. Text streams as it's written; structured output and tool calls
  // only exist once Claude is done, so they arrive in one piece at the end.
  const send = eventStream(res);
  let shownModel = model;
  let started = false;
  let streamedText = false;
  const chunk = (delta, finish_reason = null) =>
    send({ id, object: "chat.completion.chunk", created, model: shownModel, choices: [{ index: 0, delta, finish_reason }] });
  const start = () => {
    if (started) return;
    started = true;
    chunk({ role: "assistant", content: "" });
  };

  let result;
  try {
    result = await run({
      partial: !jsonSchema,
      onEvent: (event) => {
        if (event.type === "system" && event.subtype === "init" && event.model) shownModel = event.model;
        // Only top-level text; skip thinking, tool calls and sub-agent output.
        if (jsonSchema || event.type !== "stream_event" || event.parent_tool_use_id) return;
        const delta = event.event?.delta;
        if (event.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
          start();
          streamedText = true;
          chunk({ content: delta.text });
        }
      },
    });
  } catch (e) {
    if (!res.headersSent) throw e;
    // Mid-stream failure: the OpenAI SDKs raise on a chunk carrying `error`.
    if (e.status !== 499) send({ error: { message: e.message, type: e.type } });
    return res.end();
  }

  start();
  const { text, calls } = replyOf(result);
  if (!streamedText && text) chunk({ content: text });
  if (calls.length) chunk({ tool_calls: calls.map((c, index) => ({ index, ...toOpenAICall(c) })) });
  chunk({}, calls.length ? "tool_calls" : "stop");
  if (body.stream_options?.include_usage) {
    send({ id, object: "chat.completion.chunk", created, model: shownModel, choices: [], usage: openAIUsage(result) });
  }
  send("[DONE]");
  res.end();
}

function toOpenAICall(c) {
  return { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } };
}

function openAIUsage(result) {
  const u = usageOf(result);
  return {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    prompt_tokens_details: { cached_tokens: u.cache_read },
  };
}

// --- parsing ----------------------------------------------------------------------

function parseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array");
  }
  const system = [];
  const turns = [];
  for (const msg of messages) {
    switch (msg?.role) {
      case "system":
      case "developer":
        system.push(contentParts(msg.content, { images: false }).map((p) => p.text).join("\n"));
        break;
      case "user":
        turns.push({ role: "user", parts: contentParts(msg.content) });
        break;
      case "assistant": {
        const parts = contentParts(msg.content, { images: false });
        for (const call of msg.tool_calls || []) {
          let input;
          try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = call.function?.arguments; }
          parts.push({ type: "tool_call", id: call.id, name: call.function?.name, input });
        }
        turns.push({ role: "assistant", parts });
        break;
      }
      case "tool": {
        // Results of the previous assistant message's tool calls, sent back by the caller.
        const part = { type: "tool_result", id: msg.tool_call_id, parts: contentParts(msg.content, { images: false }), is_error: false };
        const last = turns.at(-1);
        if (last?.toolResults) last.parts.push(part);
        else turns.push({ role: "user", parts: [part], toolResults: true });
        break;
      }
      default:
        throw new HttpError(400, `Unsupported role "${msg?.role}"`);
    }
  }
  return { system: system.join("\n\n"), turns };
}

function contentParts(content, { images = true } = {}) {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new HttpError(400, "Message content must be a string or an array of parts");
  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (part?.type === "text") return { type: "text", text: part.text ?? "" };
    if (part?.type === "refusal") return { type: "text", text: part.refusal ?? "" };
    if (part?.type === "image_url" && images) {
      return imageFromUrl(typeof part.image_url === "string" ? part.image_url : part.image_url?.url);
    }
    throw new HttpError(400, `Unsupported content part "${part?.type}" here — text${images ? " and image_url" : ""} only`);
  });
}

function parseTools(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new HttpError(400, "`tools` must be an array");
  return tools.map((t) => {
    if (t?.type !== "function" || !t.function) throw new HttpError(400, 'Only tools of type "function" are supported');
    return toolDef(t.function.name, t.function.description, t.function.parameters);
  });
}

function parseToolChoice({ tool_choice: choice, parallel_tool_calls: parallel }) {
  if (choice == null || choice === "auto") return { mode: "auto", parallel };
  if (choice === "none" || choice === "required") return { mode: choice, parallel };
  if (choice?.type === "function" && choice.function?.name) return { mode: "required", name: choice.function.name, parallel };
  throw new HttpError(400, 'tool_choice must be "auto", "none", "required" or {"type": "function", "function": {"name": …}}');
}
