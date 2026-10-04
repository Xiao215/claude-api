// Starts the server against test/fake-claude.mjs, so tests run offline.
import { before, after } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
export const KEY = "test-key";

export function useServer(port, env = {}) {
  const base = `http://127.0.0.1:${port}`;
  let server;
  before(async () => {
    chmodSync(FAKE, 0o755);
    server = spawn(process.execPath, [SERVER], {
      cwd: tmpdir(), // so a developer's own .env isn't picked up
      env: { ...process.env, PORT: String(port), API_KEY: KEY, CLAUDE_CLI: FAKE, DEFAULT_MODEL: "sonnet", TIMEOUT_SECONDS: "2", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      server.stdout.on("data", (d) => d.toString().includes("listening") && resolve());
      server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
    });
  });
  after(() => server.kill());

  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...headers },
      body: JSON.stringify(body),
    });
  return { base, post };
}

// Splits a server-sent-events body into [{ event, data }].
export function parseSSE(raw) {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
    });
}

export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
