// POST /v1/messages — the Anthropic Messages format, for the Anthropic SDKs and
// tools that take an Anthropic base URL.

import { randomUUID } from "node:crypto";
import {
  HttpError, effortOf, maxTurnsOf, modelOf, outputOf, resolveModel, runClaude, toolServers,
} from "./claude.mjs";
import { imagePart, readToolReply, toClaudeInput, toolDef } from "./conversation.mjs";
import { disconnectSignal, eventStream, readJson, sendJson } from "./http.mjs";

export async function messages(req, res) {
  const body = await readJson(req);
  const convo = {
    system: systemText(body.system),
    turns: parseMessages(body.messages),
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
  };
  const model = resolveModel(body.model);

  let jsonSchema = null;
  const format = body.output_config?.format ?? body.output_format;
  if (format) {
    if (format.type !== "json_schema" || !format.schema) throw new HttpError(400, 'output format must be {"type": "json_schema", "schema": …}');
    jsonSchema = format.schema;
  }
  const input = toClaudeInput(convo);
  const usingTools = Boolean(input.jsonSchema);
  if (usingTools && jsonSchema) throw new HttpError(400, "Use either tools or a json_schema output format, not both");
  jsonSchema ??= input.jsonSchema;

  const request = {
    system: input.system,
    content: input.content,
    model,
    jsonSchema,
    signal: disconnectSignal(res),
    mcpServers: toolServers(body.mcp_servers),
    maxTurns: maxTurnsOf(body.max_turns),
    effort: effortOf(body.output_config?.effort),
  };
  const contentOf = (result) => {
    const out = outputOf(result);
    if (!usingTools) return [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }];
    const { text, calls } = readToolReply(out, "toolu_");
    return [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    ];
  };
  const stopReason = (content) => (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const id = `msg_${randomUUID().replaceAll("-", "")}`;

  if (!body.stream) {
    const result = await runClaude(request);
    const content = contentOf(result);
    return sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: modelOf(result, model),
      content,
      stop_reason: stopReason(content),
      stop_sequence: null,
      usage: anthropicUsage(result),
    });
  }

  // Streaming: the same event sequence the Anthropic API sends.
  const send = eventStream(res);
  const emit = (type, data) => send({ type, ...data }, type);
  let shownModel = model;
  let started = false;
  let streamedText = false;
  let index = 0;
  let textOpen = false;
  const start = () => {
    if (started) return;
    started = true;
    emit("message_start", {
      message: { id, type: "message", role: "assistant", model: shownModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  };
  const text = (t) => {
    start();
    if (!textOpen) {
      textOpen = true;
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
    }
    emit("content_block_delta", { index, delta: { type: "text_delta", text: t } });
  };
  const closeText = () => {
    if (!textOpen) return;
    emit("content_block_stop", { index: index++ });
    textOpen = false;
  };

  let result;
  try {
    result = await runClaude({
      ...request,
      partial: !jsonSchema,
      onEvent: (event) => {
        if (event.type === "system" && event.subtype === "init" && event.model) shownModel = event.model;
        // Only top-level text; skip thinking, tool calls and sub-agent output.
        if (jsonSchema || event.type !== "stream_event" || event.parent_tool_use_id) return;
        const delta = event.event?.delta;
        if (event.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
          streamedText = true;
          text(delta.text);
        }
      },
    });
  } catch (e) {
    if (!res.headersSent) throw e;
    if (e.status !== 499) emit("error", { error: { type: anthropicErrorType(e.type), message: e.message } });
    return res.end();
  }

  start();
  const content = contentOf(result);
  for (const block of content) {
    if (block.type === "text") {
      if (!streamedText && block.text) text(block.text);
      continue;
    }
    closeText();
    emit("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    emit("content_block_stop", { index: index++ });
  }
  closeText();
  const usage = anthropicUsage(result);
  emit("message_delta", { delta: { stop_reason: stopReason(content), stop_sequence: null }, usage });
  emit("message_stop", {});
  res.end();
}

function anthropicUsage(result) {
  const u = result.usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
  };
}

export function anthropicErrorType(type) {
  const known = ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error"];
  return known.includes(type) ? type : "api_error";
}

// --- parsing ----------------------------------------------------------------------

function systemText(system) {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (b?.type === "text" ? b.text : "")).join("\n\n");
  throw new HttpError(400, "`system` must be a string or an array of text blocks");
}

function parseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array");
  }
  return messages.map((m) => {
    if (m?.role !== "user" && m?.role !== "assistant") throw new HttpError(400, `Unsupported role "${m?.role}"`);
    return { role: m.role, parts: blocks(m.content) };
  });
}

function blocks(content, { inToolResult = false } = {}) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content == null && inToolResult) return [];
  if (!Array.isArray(content)) throw new HttpError(400, "Message content must be a string or an array of blocks");
  return content.flatMap((b) => {
    switch (b?.type) {
      case "text":
        return [{ type: "text", text: b.text ?? "" }];
      case "image":
        if (b.source?.type !== "base64") throw new HttpError(400, "Images must be base64 sources; image URLs aren't fetched");
        return [imagePart(b.source.media_type, b.source.data)];
      case "thinking":
      case "redacted_thinking":
        return []; // earlier reasoning; not needed to continue
      case "tool_use":
        if (inToolResult) break;
        return [{ type: "tool_call", id: b.id, name: b.name, input: b.input }];
      case "tool_result":
        if (inToolResult) break;
        return [{ type: "tool_result", id: b.tool_use_id, is_error: Boolean(b.is_error), parts: blocks(b.content, { inToolResult: true }) }];
    }
    throw new HttpError(400, `Unsupported content block "${b?.type}"`);
  });
}

function parseTools(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new HttpError(400, "`tools` must be an array");
  return tools.map((t) => {
    if (t?.type && t.type !== "custom") throw new HttpError(400, `Server tool "${t.type}" isn't supported — only your own tools`);
    return toolDef(t?.name, t?.description, t?.input_schema);
  });
}

function parseToolChoice(choice) {
  const parallel = choice?.disable_parallel_tool_use ? false : undefined;
  switch (choice?.type) {
    case undefined:
    case "auto":
      return { mode: "auto", parallel };
    case "any":
      return { mode: "required", parallel };
    case "tool":
      return { mode: "required", name: choice.name, parallel };
    case "none":
      return { mode: "none" };
  }
  throw new HttpError(400, 'tool_choice.type must be "auto", "any", "tool" or "none"');
}
