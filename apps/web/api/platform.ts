import type { IncomingMessage, ServerResponse } from "node:http";
import { resolvePlatformApiProxyOrigin } from "../src/platformProxyConfig.js";

const MAX_PROXY_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PROXY_PATH_PARAMETER = "__blob_proxy_path";
const ALLOWED_METHODS = new Set(["GET", "PATCH", "POST"]);
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "cookie", "origin"];
const FORWARDED_RESPONSE_HEADERS = ["cache-control", "content-type", "retry-after", "www-authenticate"];

/**
 * A narrow same-site bridge while api.blob.lat is unavailable. It is an HTTP
 * proxy only: no wallet key, database access, game authority, or WebSocket
 * traffic runs on Vercel. The upstream host is server-only configuration.
 */
export default async function platformApiProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const upstreamOrigin = resolvePlatformApiProxyOrigin();
  if (!upstreamOrigin) {
    sendJson(response, 503, { error: "PLATFORM_API_UNAVAILABLE", message: "The profile service is not configured." });
    return;
  }
  const method = request.method ?? "GET";
  if (!ALLOWED_METHODS.has(method)) {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  const target = resolveTargetUrl(request.url, upstreamOrigin);
  if (!target) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  let body: Buffer | undefined;
  try {
    body = await readBoundedBody(request, method);
  } catch (error) {
    if (error instanceof ProxyRequestTooLargeError) {
      sendJson(response, 413, { error: "REQUEST_TOO_LARGE", message: "Request data is too large." });
      return;
    }
    sendJson(response, 400, { error: "REQUEST_INVALID", message: "Request data is invalid." });
    return;
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers: copyRequestHeaders(request),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    copyResponseHeaders(upstream.headers, response);
    response.statusCode = upstream.status;
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(response, 503, { error: "PLATFORM_API_UNAVAILABLE", message: "The profile service is unavailable." });
  }
}

function resolveTargetUrl(rawRequestUrl: string | undefined, upstreamOrigin: string): string | undefined {
  try {
    const requestUrl = new URL(rawRequestUrl ?? "/", "https://blob.invalid");
    const relativePath = requestUrl.searchParams.get(PROXY_PATH_PARAMETER);
    requestUrl.searchParams.delete(PROXY_PATH_PARAMETER);
    if (!relativePath) {
      return undefined;
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      return undefined;
    }
    const target = new URL("/v1/" + segments.map((segment) => encodeURIComponent(segment)).join("/"), upstreamOrigin);
    target.search = requestUrl.search;
    return target.toString();
  } catch {
    return undefined;
  }
}

function copyRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  return headers;
}

function copyResponseHeaders(headers: Headers, response: ServerResponse): void {
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) {
      response.setHeader(name, value);
    }
  }
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) {
    response.setHeader("Set-Cookie", setCookies);
  }
}

async function readBoundedBody(request: IncomingMessage, method: string): Promise<Buffer | undefined> {
  if (method === "GET") {
    return undefined;
  }
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > MAX_PROXY_BODY_BYTES) {
    throw new ProxyRequestTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROXY_BODY_BYTES) {
      throw new ProxyRequestTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class ProxyRequestTooLargeError extends Error {}

function sendJson(response: ServerResponse, status: number, payload: object): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.end(JSON.stringify(payload));
}
