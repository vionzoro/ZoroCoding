import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
export type ResolveToken = (
  secretRef: string,
) => string | undefined | Promise<string | undefined>;
export interface HttpTransportOptions {
  endpoint: string;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  secretRef?: string;
  resolveToken?: ResolveToken;
}

export class IntegrationError extends Error {
  constructor(public readonly code: string) {
    super(`集成请求失败：${code}。`);
    this.name = "IntegrationError";
  }
}

export function integrationTimeout(timeoutMs = 20_000): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 15_000 || timeoutMs > 30_000) {
    throw new IntegrationError("invalid_timeout");
  }
  return timeoutMs;
}

/** Main-process only. Construction is inert; requests never redirect or retry. */
export class HttpTransport {
  private readonly endpoint: URL;
  readonly timeoutMs: number;
  private readonly options: HttpTransportOptions;

  constructor(options: HttpTransportOptions) {
    this.options = { ...options };
    this.timeoutMs = integrationTimeout(options.timeoutMs);
    try {
      this.endpoint = new URL(options.endpoint);
    } catch {
      throw new IntegrationError("invalid_endpoint");
    }
    const loopback = this.endpoint.hostname === "127.0.0.1" || this.endpoint.hostname === "[::1]";
    if (
      (this.endpoint.protocol !== "https:" &&
        !(this.endpoint.protocol === "http:" && options.allowLoopbackHttp === true && loopback)) ||
      this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash
    ) {
      throw new IntegrationError("invalid_endpoint");
    }
    if (options.secretRef !== undefined && !options.resolveToken) {
      throw new IntegrationError("missing_token_resolver");
    }
  }

  async post(
    body: unknown,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
    notification = false,
  ): Promise<{ body: unknown; sessionId?: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, this.timeoutMs);
    let token: string | undefined;
    try {
      return await new Promise((resolve, reject) => {
        const cancelled = () => reject(new IntegrationError(timedOut ? "timeout" : "cancelled"));
        controller.signal.addEventListener("abort", cancelled, { once: true });
        if (controller.signal.aborted) {
          cancelled();
          return;
        }
        void (async () => {
          try {
            if (this.options.secretRef !== undefined) {
              token = await this.options.resolveToken!(this.options.secretRef);
              if (!token || /[\r\n]/.test(token)) {
                throw new IntegrationError("token_unavailable");
              }
            }
            if (controller.signal.aborted) return;
            const payload = JSON.stringify(body);
            const request = (this.endpoint.protocol === "https:" ? httpsRequest : httpRequest)(this.endpoint, {
              method: "POST",
              signal: controller.signal,
              headers: {
                ...headers,
                "Content-Type": "application/json",
                Accept: "application/json",
                "Content-Length": Buffer.byteLength(payload),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            }, (response) => {
              const fail = (code: string) => {
                reject(new IntegrationError(code));
                response.destroy();
              };
              const status = response.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                fail("redirect_rejected");
                return;
              }
              if (status === 401 || status === 403) {
                fail("unauthorized");
                return;
              }
              if (status < 200 || status >= 300) {
                fail("http_status");
                return;
              }
              const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
              if (contentType === "text/event-stream") {
                fail("sse_unsupported");
                return;
              }
              if (!notification && contentType !== "application/json") {
                fail("invalid_content_type");
                return;
              }
              if (Number(response.headers["content-length"]) > MAX_HTTP_RESPONSE_BYTES) {
                fail("response_too_large"); return;
              }
              let size = 0;
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_HTTP_RESPONSE_BYTES) {
                  fail("response_too_large");
                  return;
                }
                chunks.push(chunk);
              });
              response.on("error", () => reject(new IntegrationError("network_error")));
              response.on("end", () => {
                try {
                  const raw = Buffer.concat(chunks).toString("utf8");
                  const parsed: unknown = notification && raw.length === 0 ? null : JSON.parse(raw);
                  // Exact credential filtering also covers JSON-escaped echoes, keys and nested strings.
                  const clean = (value: unknown): unknown => {
                    if (typeof value === "string") {
                      if (!token) return value;
                      // MCP text blocks can contain another encoded JSON document.
                      // Scrub decoded strings before they become prompt context.
                      try {
                        const nested: unknown = JSON.parse(value);
                        if (nested && typeof nested === "object") return JSON.stringify(clean(nested));
                      } catch { /* Plain text is handled below. */ }
                      return value.split(token).join("[已隐藏]");
                    }
                    if (Array.isArray(value)) return value.map(clean);
                    if (value && typeof value === "object") {
                      return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), clean(item)]));
                    }
                    return value;
                  };
                  const sessionId = response.headers["mcp-session-id"];
                  if (sessionId !== undefined &&
                    (typeof sessionId !== "string" || sessionId.length > 256 || !/^[\x21-\x7e]+$/.test(sessionId) || (token && sessionId.includes(token)))) {
                    throw new IntegrationError("invalid_session");
                  }
                  resolve({ body: clean(parsed), sessionId });
                } catch {
                  reject(new IntegrationError("malformed_response"));
                }
              });
            });
            request.on("error", () => reject(new IntegrationError(controller.signal.aborted ?
              (timedOut ? "timeout" : "cancelled") : "network_error")));
            request.end(payload);
          } catch (error) {
            reject(error instanceof IntegrationError ? error : new IntegrationError("request_failed"));
          }
        })();
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}
