import type { CapturedLink, CapturedMessage } from "./types.js";

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    throw new RequestValidationError(`Invalid ${name}`);
  }
  return value.trim();
}

function readLink(value: unknown, index: number): CapturedLink {
  if (!record(value)) throw new RequestValidationError(`Invalid link ${index}`);
  const text = boundedString(value.text, `link text ${index}`, 250, true);
  const href = boundedString(value.href, `link URL ${index}`, 2048);

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new RequestValidationError(`Invalid link URL ${index}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RequestValidationError(`Unsupported link URL ${index}`);
  }

  // URL paths, query strings, and fragments can carry per-recipient IDs or tokens.
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return { text, href: url.toString() };
}

export function validateCapturedMessage(value: unknown): CapturedMessage {
  if (!record(value) || !record(value.sender) || !Array.isArray(value.links)) {
    throw new RequestValidationError("Invalid message payload");
  }
  if (value.links.length > 50) throw new RequestValidationError("Too many links");
  if (typeof value.bodyTruncated !== "boolean" || typeof value.linksTruncated !== "boolean") {
    throw new RequestValidationError("Invalid capture status");
  }

  return {
    subject: boundedString(value.subject, "subject", 500),
    sender: {
      name: boundedString(value.sender.name, "sender name", 200, true),
      email: boundedString(value.sender.email, "sender email", 320, true)
    },
    body: boundedString(value.body, "body", 30_000),
    bodyTruncated: value.bodyTruncated,
    links: value.links.map(readLink),
    linksTruncated: value.linksTruncated
  };
}
