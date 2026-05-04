import http from "node:http";

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Request body is not valid JSON");
    this.name = "InvalidJsonBodyError";
  }
}

export function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

export function respondPng(
  response: http.ServerResponse,
  statusCode: number,
  buffer: Buffer,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "image/png",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  response.end(buffer);
}

export function respondHtml(
  response: http.ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html, "utf8"),
    "Cache-Control": "no-store",
  });
  response.end(html);
}

export async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new InvalidJsonBodyError();
  }
}
