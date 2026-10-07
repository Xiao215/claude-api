# claude-api

Use **Claude Code** from your own scripts and tools. A small local server speaks the
**OpenAI** and **Anthropic** API formats, so code that already talks to either one
switches over by changing its base URL. Requests run on your Claude Pro/Max
subscription.

```
your script ──HTTP──▶ claude-api (localhost:8787) ──▶ `claude` CLI (signed in as you) ──▶ Claude
```

Each request runs the official, unmodified `claude` CLI on your machine. No
dependencies: just Node 22+ and Claude Code.

```bash
$ curl -s localhost:8787/ask -H 'Content-Type: application/json' \
    -d '{"prompt": "Explain compound interest in one sentence", "model": "haiku"}'
{"reply":"Compound interest is interest earned on both your original money and the interest it has already earned.","model":"claude-haiku-4-5-20251001", ...}
```

## Personal use only

Your Pro/Max plan is for **you**. This is for your own scripts and projects that only
you use. Don't put it on the internet, share it, or connect apps that serve other
people. Routing other users' requests through your subscription breaks Anthropic's
terms and puts your account at risk. For anything with real users, get an API key from
[Claude Console](https://platform.claude.com/) instead. Your app code stays the same:
point it at Anthropic's API rather than at this service.

## What it supports

- **OpenAI** `POST /v1/chat/completions` and **Anthropic** `POST /v1/messages`, plus a
  minimal `POST /ask`
- Streaming (server-sent events, in each API's own event format)
- **Tool / function calling**: `tools`, `tool_choice`, tool results sent back in history
- **Images and PDFs** (base64 / `data:` URLs)
- **Structured JSON output** validated against a JSON Schema
- Thinking effort per request
- Attaching your own local MCP tool servers, so Claude runs a whole agent loop
- Model names mapped for you (`gpt-4o-mini` → haiku), or your own aliases
- `/stats`: tokens used since start, plus how much of your 5-hour and weekly plan
  windows you've used

## Setup

You need [Node.js](https://nodejs.org/) 22+ and
[Claude Code](https://docs.claude.com/en/docs/claude-code), signed in:

```bash
claude            # once: type /login, finish in the browser, then /exit
```

Then:

```bash
git clone https://github.com/Xiao215/claude-api && cd claude-api
cp .env.example .env    # optional: defaults are fine
npm start
```

It prints the base URLs to paste into your app, and warns if Claude Code isn't
installed or signed in:

```
claude-api listening on http://127.0.0.1:8787
  Signed in to Claude (max plan) as you@example.com

  OpenAI SDKs      base_url = http://127.0.0.1:8787/v1
  Anthropic SDKs   base_url = http://127.0.0.1:8787
  api_key          any value (no API_KEY set)
```

To run it in the background and start it at login (macOS via launchd, Linux via a
systemd user service):

```bash
npm run install-service      # undo: npm run uninstall-service
```

Logs: `~/Library/Logs/claude-api.log` on macOS, `journalctl --user -u claude-api -f`
on Linux. On Windows, `npm start` should work but is untested. WSL is the safer bet.

## Connect your apps

**OpenAI SDK (Python)**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")  # or your API_KEY

r = client.chat.completions.create(
    model="sonnet",  # haiku | sonnet | opus | fable | claude-* id; others are mapped
    messages=[{"role": "system", "content": "You are a finance assistant."},
              {"role": "user", "content": "Summarize my spending: ..."}],
)
print(r.choices[0].message.content)
```

**Anthropic SDK (Python)**

```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:8787", api_key="unused")

msg = client.messages.create(model="sonnet", max_tokens=1024,
                             messages=[{"role": "user", "content": "Hello"}])
print(msg.content[0].text)
```

**JavaScript**

```js
import OpenAI from "openai";
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "unused" });

import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787", apiKey: "unused" });
```

**No code change.** Many tools read these from the environment:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=unused
```

(This doesn't affect claude-api itself: the `claude` it runs always uses your claude.ai
login and never sees these variables.)

## Features

### Tool calling

Pass `tools` exactly as you would to OpenAI or Anthropic. When Claude wants a tool, you
get back `tool_calls` (OpenAI, `finish_reason: "tool_calls"`) or `tool_use` blocks
(Anthropic, `stop_reason: "tool_use"`). Run the tool, append the result to the
messages, and call again. `tool_choice` (`auto`, `required`/`any`, a named tool,
`none`) and turning off parallel calls are supported. Agent frameworks built on
either SDK work this way.

```python
tools = [{"type": "function", "function": {"name": "get_weather",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
r = client.chat.completions.create(model="haiku", messages=msgs, tools=tools)
call = r.choices[0].message.tool_calls[0]   # get_weather {"city": "Toronto"}
msgs += [r.choices[0].message, {"role": "tool", "tool_call_id": call.id, "content": "-3C, snowing"}]
r = client.chat.completions.create(model="haiku", messages=msgs, tools=tools)
```

Claude Code doesn't support client-side tools itself, so this service emulates them:
your tools are described in the system prompt as ones the caller runs, Claude answers
through a JSON schema that is either a reply or a list of calls, and the arguments are
validated against each tool's `parameters`. With tools offered, the
reply arrives in one piece at the end even when streaming.

Tools and a structured reply work together, as on the real APIs: pass `tools` with
`response_format: {"type": "json_schema", …}` (or Anthropic's `output_config.format`) and
Claude may call tools first, then answers with JSON in your schema.

### Web search, per request

OpenAI's `web_search_options: {}` or Anthropic's server tools (`{"type":
"web_search_20250305", "name": "web_search"}`, `web_fetch_*`) let Claude search and read the
web for that request only, with Claude Code's own WebSearch and WebFetch. `/ask` takes
`"web_search": true`. Other requests stay without tools. `TOOLS=WebSearch,WebFetch` still turns
it on for every request.

### Images

OpenAI: `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}`.
Anthropic: `{"type": "image", "source": {"type": "base64", ...}}`. PNG, JPEG, GIF and
WebP. Remote image URLs aren't fetched, so send the bytes.

### PDFs

OpenAI: `{"type": "file", "file": {"filename": "a.pdf", "file_data": "data:application/pdf;base64,..."}}`.
Anthropic: `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "..."}}`.
Claude reads the text and the page images. Uploaded file ids and remote URLs aren't supported, so
send the bytes.

### Structured JSON

Pass a JSON Schema and get validated JSON back:

```python
r = client.chat.completions.create(model="haiku", messages=[...],
    response_format={"type": "json_schema", "json_schema": {"name": "tx", "schema": {...}}})
data = json.loads(r.choices[0].message.content)
```

Anthropic: `output_config={"format": {"type": "json_schema", "schema": {...}}}`.
`/ask`: `"json_schema": {...}`. OpenAI's `{"type": "json_object"}` is also accepted.

### Thinking effort

OpenAI's `reasoning_effort`, Anthropic's `output_config.effort`, or `effort` on `/ask`:
`low` | `medium` | `high` | `xhigh` | `max`. The default comes from `EFFORT`.

### Agents: attaching MCP tool servers (non-standard extension)

All three endpoints also accept:

- `mcp_servers: [{"name": "finstore", "url": "http://127.0.0.1:4700/mcp/…"}]`: MCP tool
  servers (Streamable HTTP) that Claude may call, as many times as it needs, before it
  answers. Only `http://` URLs on localhost are accepted, never commands, and every tool
  of an attached server is pre-approved (headless mode can't ask).
- `max_turns: 12`: a cap on agent steps. Exceeding it returns HTTP 422.

Unlike `tools`, here Claude Code runs the loop itself, and your server only answers
`tools/list` and `tools/call`. What a tool returns is what Claude sees, so the tool
server is where you decide how much of your data an agent can reach.

## Endpoints

| Endpoint | |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat format |
| `POST /v1/messages` | Anthropic Messages format |
| `POST /ask` | `{"prompt", "system"?, "model"?, "json_schema"?, "effort"?, "web_search"?}` → `{"reply", "model", "usage"}` |
| `GET /v1/models` | Model aliases, in OpenAI or Anthropic shape (by `anthropic-version` header) |
| `GET /stats` | Requests, errors, tokens per model, and your plan usage (`plan.windows`) as of the last request |
| `GET /health` | Status, no auth |

## Configuration (`.env`)

`.env` is read from the folder you start claude-api in. Real environment variables win.

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Keep localhost unless you set `API_KEY` |
| `API_KEY` | none | Required as `Authorization: Bearer …` or `x-api-key` when set. Required to bind beyond localhost |
| `DEFAULT_MODEL` | `sonnet` | Used when a model name doesn't map to Claude (e.g. `gpt-4o`) |
| `MODEL_ALIASES` | none | Your own names, e.g. `gpt-4o-mini=haiku,gpt-4o=sonnet` |
| `TOOLS` | none | e.g. `WebSearch,WebFetch` to let Claude search the web. Files and shell are never enabled. |
| `EFFORT` | CLI default | `low` … `max` thinking effort |
| `MAX_CONCURRENT` | `2` | Extra requests wait in line |
| `TIMEOUT_SECONDS` | `300` | |
| `ALLOWED_ORIGINS` | none | Requests carrying a browser `Origin` are refused unless listed, so a web page can't spend your subscription |
| `CLAUDE_CLI` | `claude` | Full path, if it isn't on `PATH` |

Without your own aliases, names that don't mention a Claude model are mapped by size:
`*-mini`, `*-nano`, `*-flash`, `*-lite` → haiku. `o1`/`o3`-style, `*-pro` and `*-large` → opus.
Everything else → `DEFAULT_MODEL`.

To reach it from your other devices, keep `HOST=127.0.0.1` and use something like
Tailscale, or set `HOST=0.0.0.0` with a strong `API_KEY` on a trusted network only.

## Privacy: what reaches Anthropic

Claude runs on Anthropic's servers, so **the prompt and the reply of every request are
sent to Anthropic** (encrypted in transit). Nothing can change that short of a local
model. What this service does about everything else:

- Turns off Claude Code's usage metrics, error reports, feedback surveys and transcript
  uploads (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and friends).
- Writes no transcripts to `~/.claude` (`--no-session-persistence`) and never logs
  prompts, only route, status and timing.
- Gives Claude no built-in tools by default, so it can't fetch URLs or touch files. A request
  that asks for web search gets WebSearch and WebFetch for itself only; files and shell never.
  Nothing a prompt says can make it send your data anywhere else.

One setting only you can change: **claude.ai → Settings → Privacy → Help improve Claude → off**.
With it off, Anthropic keeps your chats 30 days and doesn't train on them. With it on,
it keeps them 5 years and may use them for training. Turn it off before sending
personal data.

For data that must never leave your machine, point your app at a local model instead
(e.g. Ollama, which serves an OpenAI-compatible API at `http://127.0.0.1:11434/v1`).

## Limits compared with a real API

- **About 2–5 s of startup per request** (a fresh `claude` process each time). Fine for
  interactive use. For bulk jobs, batch your data (one request per month of
  transactions, not one per transaction).
- **Your plan's usage limits apply** (5-hour and weekly windows). When you hit them,
  requests fail with HTTP 429. `/stats` shows how close you are.
- Conversations are stateless: send the full history each time, as with the real APIs.
  Multi-turn history is flattened into one prompt.
- Ignored: `temperature`, `top_p`, `max_tokens`, `stop`, `n` (only one choice).
  Not supported: audio, files other than PDFs, uploaded file ids, remote image/PDF URLs, Anthropic server tools other than
  web search and web fetch, `/v1/messages/count_tokens`.
- Runs only where `claude` is signed in, i.e. your machine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503` … "run `claude` then /login" | The CLI is signed out. Run `claude`, type `/login`, then `/exit`. |
| `429` | You've reached your plan's usage window. Check `/stats` → `plan.windows` for when it resets. |
| `Could not run "claude"` | `claude` isn't on `PATH` for this process (common under a background service). Set `CLAUDE_CLI` to the output of `which claude`, or rerun `npm run install-service`. |
| `403` "Requests from web pages" | Calls from a browser page are blocked by default. Add the page's origin to `ALLOWED_ORIGINS` if you mean it. |
| `504` | The request took longer than `TIMEOUT_SECONDS`. |
| "Port 8787 is already in use" | It's already running (maybe as the background service), or set `PORT`. |

## Development

```bash
npm test   # offline: uses test/fake-claude.mjs, no Claude account or requests
```

The code is small: `server.mjs` (routes), `lib/openai.mjs` and `lib/anthropic.mjs`
(the two API formats), `lib/conversation.mjs` (turning either into one prompt, and
tool calls), `lib/claude.mjs` (running the CLI).
