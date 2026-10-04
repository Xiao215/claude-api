// The shared middle: both API formats are parsed into one conversation shape,
// which this file turns into the single prompt the CLI takes.
//
// A conversation is { system, turns, tools, toolChoice }, where each turn is
// { role: "user" | "assistant", parts } and a part is one of
//   { type: "text", text }
//   { type: "image", media_type, data }            (base64)
//   { type: "tool_call", id, name, input }
//   { type: "tool_result", id, parts, is_error }
// tools are [{ name, description, parameters }] and toolChoice is
// { mode: "auto" | "required" | "none", name?, parallel? }.

import { randomBytes } from "node:crypto";
import { HttpError } from "./claude.mjs";
import { DEFAULT_SYSTEM } from "./config.mjs";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function imagePart(media_type, data) {
  if (!IMAGE_TYPES.includes(media_type)) throw new HttpError(400, `Images must be one of ${IMAGE_TYPES.join(", ")}`);
  if (typeof data !== "string" || !data) throw new HttpError(400, "Image data must be a base64 string");
  return { type: "image", media_type, data };
}

// "data:image/png;base64,...." -> image part. Remote URLs aren't fetched.
export function imageFromUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url || "");
  if (!m) throw new HttpError(400, "Images must be sent inline as data: URLs (base64); remote image URLs aren't fetched");
  return imagePart(m[1], m[2]);
}

export function toolDef(name, description, parameters) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name || "")) throw new HttpError(400, "Tool names must be 1-64 letters, digits, - or _");
  return { name, description: description || "", parameters: parameters || { type: "object", properties: {} } };
}

export function callId(prefix) {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

// --- conversation -> CLI input ----------------------------------------------------

// Returns { system, content, jsonSchema } for runClaude. The CLI takes one
// system prompt and one user message, so a multi-turn chat is flattened into a
// transcript; images stay in place as image blocks. When tools are offered,
// Claude answers through a JSON schema that is either a reply or tool calls.
export function toClaudeInput({ system, turns, tools = [], toolChoice = { mode: "auto" } }) {
  if (!turns.some((t) => t.role === "user")) throw new HttpError(400, "Need at least one user message");
  const offered = toolChoice.mode === "none" ? [] : tools;
  if (toolChoice.name && !offered.some((t) => t.name === toolChoice.name)) {
    throw new HttpError(400, `tool_choice names "${toolChoice.name}", which isn't in tools`);
  }
  if (toolChoice.mode === "required" && !offered.length) throw new HttpError(400, "tool_choice requires a tool but no tools were given");

  let sys = system || DEFAULT_SYSTEM;
  if (offered.length) sys += toolInstructions(offered, toolChoice);
  return {
    system: sys,
    content: transcript(turns),
    jsonSchema: offered.length ? toolSchema(offered, toolChoice) : null,
  };
}

function transcript(turns) {
  const blocks = [];
  const text = (s) => {
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += s;
    else blocks.push({ type: "text", text: s });
  };
  const image = (p) => blocks.push({ type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } });

  // A lone user message goes through as-is.
  const [first] = turns;
  if (turns.length === 1 && first.parts.every((p) => p.type === "text" || p.type === "image")) {
    first.parts.forEach((p, i) => {
      if (p.type === "image") return image(p);
      text((i > 0 && first.parts[i - 1].type === "text" ? "\n" : "") + p.text);
    });
    return blocks;
  }

  text("<conversation>\n");
  for (const turn of turns) {
    text(`<${turn.role}>\n`);
    for (const p of turn.parts) {
      if (p.type === "text") text(`${p.text}\n`);
      else if (p.type === "image") image(p);
      else if (p.type === "tool_call") text(`<tool_call id="${p.id}" name="${p.name}">${JSON.stringify(p.input ?? {})}</tool_call>\n`);
      else if (p.type === "tool_result") {
        text(`<tool_result id="${p.id}"${p.is_error ? ' error="true"' : ""}>\n`);
        for (const inner of p.parts) inner.type === "image" ? image(inner) : text(`${inner.text}\n`);
        text("</tool_result>\n");
      }
    }
    text(`</${turn.role}>\n`);
  }
  text(
    "</conversation>\n\n" +
      "Continue this conversation: write the assistant's next reply. " +
      "Reply with the message text only, no tags.",
  );
  return blocks;
}

function toolInstructions(tools, choice) {
  const must = choice.name
    ? ` You must call ${choice.name} now.`
    : choice.mode === "required" ? " You must call at least one tool now." : "";
  const list = tools
    .map((t) => `## ${t.name}\n${t.description}\nParameters (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join("\n\n");
  return (
    "\n\n# Tools\n" +
    "You can call the tools below. You don't run them yourself: the caller runs them and sends the " +
    "results back in a later message as <tool_result>. To call tools, respond with type \"tool_calls\" " +
    "and list the calls (content may hold a short note). Otherwise respond with type \"message\" and " +
    `put your whole reply in content.${must}\n\n${list}`
  );
}

function toolSchema(tools, choice) {
  const callable = choice.name ? tools.filter((t) => t.name === choice.name) : tools;
  const mustCall = Boolean(choice.name) || choice.mode === "required";
  return {
    type: "object",
    properties: {
      type: { enum: mustCall ? ["tool_calls"] : ["message", "tool_calls"] },
      content: { type: "string" },
      tool_calls: {
        type: "array",
        minItems: 1,
        ...(choice.parallel === false ? { maxItems: 1 } : {}),
        items: {
          anyOf: callable.map((t) => ({
            type: "object",
            properties: { name: { const: t.name }, arguments: t.parameters },
            required: ["name", "arguments"],
          })),
        },
      },
    },
    required: mustCall ? ["type", "tool_calls"] : ["type"],
  };
}

// --- CLI output -> reply ----------------------------------------------------------

// With tools offered, the structured output is { type, content, tool_calls };
// returns { text, calls } with fresh ids in the caller's id format.
export function readToolReply(output, idPrefix) {
  const calls = output?.type === "tool_calls" && Array.isArray(output.tool_calls) ? output.tool_calls : [];
  return {
    text: typeof output?.content === "string" ? output.content : "",
    calls: calls.map((c) => ({ id: callId(idPrefix), name: c.name, input: c.arguments ?? {} })),
  };
}
