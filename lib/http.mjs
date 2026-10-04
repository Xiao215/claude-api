// HTTP plumbing shared by the routes.

import { HttpError } from "./claude.mjs";
import { MAX_BODY_BYTES } from "./config.mjs";

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, "Body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Server-sent events. Headers go out with the first event, so errors before
// any output can still be sent as a normal JSON error response.
export function eventStream(res) {
  return (data, event) => {
    if (!res.headersSent) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    }
    res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  };
}

// Aborts when the client goes away, so we stop the CLI instead of burning limits.
export function disconnectSignal(res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}
