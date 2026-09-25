import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TypeSafeError } from "@typesafe-ai/sdk";
import { analyzeMessage } from "./analyzer.js";
import { RequestValidationError, validateBatchMessages, validateCapturedMessage } from "./validation.js";
import type { BatchAnalysisResult, BatchCapturedMessage } from "./types.js";

const PORT = Number(process.env.PORT || "8787");
const EXTENSION_ID = process.env.EXTENSION_ID || "";
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "";
const MAX_BODY_BYTES = 1_500_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const BATCH_CONCURRENCY = 3;
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();

if (!TYPESAFE_API_KEY.trim()) {
  console.error("Set TYPESAFE_API_KEY in server/.env before starting the relay.");
  process.exit(1);
}
if (!/^[a-p]{32}$/.test(EXTENSION_ID)) {
  console.error("Set EXTENSION_ID to the 32-character ID shown on chrome://extensions.");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be a valid TCP port.");
  process.exit(1);
}

const allowedOrigin = `chrome-extension://${EXTENSION_ID}`;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function allowOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (origin !== allowedOrigin) return false;

  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Vary", "Origin");
  return true;
}

function withinRateLimit(request: IncomingMessage, cost: number): boolean {
  const key = request.socket.remoteAddress || "local";
  const now = Date.now();
  const current = rateBuckets.get(key);

  if (!current || current.resetsAt <= now) {
    rateBuckets.set(key, { count: cost, resetsAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count + cost > RATE_LIMIT) return false;
  current.count += cost;
  return true;
}

function shouldStopBatch(error: unknown): boolean {
  if (!(error instanceof TypeSafeError) || !("status" in error)) return false;
  const status = Number(error.status);
  return status === 401 || status === 403 || status === 429;
}

async function analyzeBatch(messages: BatchCapturedMessage[]): Promise<BatchAnalysisResult[]> {
  const results: Array<BatchAnalysisResult | undefined> = new Array(messages.length);
  let nextIndex = 0;
  let stopStartingRequests = false;

  async function worker(): Promise<void> {
    while (!stopStartingRequests) {
      const index = nextIndex++;
      if (index >= messages.length) return;

      try {
        results[index] = { index, result: await analyzeMessage(messages[index]) };
      } catch (error) {
        results[index] = { index, error: "analysis_failed" };
        if (shouldStopBatch(error)) stopStartingRequests = true;
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.error(`TypeSafe batch item ${index + 1} failed:`, errorName);
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(BATCH_CONCURRENCY, messages.length) },
    () => worker()
  ));

  return results.map((result, index) => result ?? { index, error: "not_analyzed" });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] || "0");
  if (contentLength > MAX_BODY_BYTES) throw new RequestValidationError("Request body is too large");

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestValidationError("Request body is too large");
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestValidationError("Request body must be valid JSON");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (url.pathname === "/health" && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/analyze" && url.pathname !== "/analyze-batch") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  if (!allowOrigin(request, response)) {
    sendJson(response, 403, { error: "origin_not_allowed" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    });
    response.end();
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "content_type_must_be_json" });
    return;
  }
  try {
    const payload = await readJson(request);

    if (url.pathname === "/analyze") {
      if (typeof payload !== "object" || payload === null || !("message" in payload)) {
        throw new RequestValidationError("Expected a message field");
      }
      const message = validateCapturedMessage(payload.message);
      if (!withinRateLimit(request, 1)) {
        sendJson(response, 429, { error: "rate_limited" });
        return;
      }
      const result = await analyzeMessage(message);
      sendJson(response, 200, result);
      return;
    }

    if (typeof payload !== "object" || payload === null || !("messages" in payload)) {
      throw new RequestValidationError("Expected a messages field");
    }
    const messages = validateBatchMessages(payload.messages);
    if (!withinRateLimit(request, messages.length)) {
      sendJson(response, 429, { error: "rate_limited" });
      return;
    }
    sendJson(response, 200, { results: await analyzeBatch(messages) });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }

    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("TypeSafe analysis failed:", errorName);
    const status = error instanceof TypeSafeError && "status" in error && error.status === 429 ? 503 : 502;
    sendJson(response, status, { error: "analysis_failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Inbox Signal Jev relay listening on http://127.0.0.1:${PORT}`);
  console.log(`Allowed extension origin: ${allowedOrigin}`);
});
