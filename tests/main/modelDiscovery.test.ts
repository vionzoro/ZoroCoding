import { describe, expect, it, vi } from "vitest";

import { discoverModels } from "../../src/main/models/modelDiscovery";
import { PROVIDER_TEMPLATES } from "../../src/main/models/providerTemplates";

describe("provider templates", () => {
  it("contains every requested provider without credentials", () => {
    expect(PROVIDER_TEMPLATES.map((item) => item.id)).toEqual([
      "kimi-k3",
      "groq",
      "gemini",
      "openrouter",
      "cerebras",
      "sambanova",
      "mistral",
      "nvidia",
      "zhipu",
      "ollama",
    ]);
    expect(JSON.stringify(PROVIDER_TEMPLATES)).not.toMatch(
      /("apiKey"|gsk_|sk-or-|csk-|nvapi-)/i,
    );
  });

  it("marks only providers that require authenticated discovery before save", () => {
    expect(
      PROVIDER_TEMPLATES.filter((item) => item.requiresDiscovery).map(
        (item) => item.id,
      ),
    ).toEqual(["cerebras", "sambanova", "nvidia", "zhipu"]);
  });
});

describe("discoverModels", () => {
  it("trims and normalizes a padded Base URL before requesting models", async () => {
    let requestedUrl = "";
    await discoverModels({
      baseUrl: "  https://api.example.com/v1///  ",
      apiKey: "private-test-key",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return Response.json({ data: [] });
      },
    });

    expect(requestedUrl).toBe("https://api.example.com/v1/models");
  });

  it.each(["", "   ", "x".repeat(4_097)])(
    "rejects an empty, whitespace-only, or oversized API key",
    async (apiKey) => {
      const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

      await expect(
        discoverModels({
          baseUrl: "https://api.example.com/v1",
          apiKey,
          fetchImpl,
        }),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown direct discovery input fields", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        fetchImpl,
        unexpected: true,
      } as never),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rethrows AbortError without converting it to a network failure", async () => {
    const abortError = new DOMException("test abort", "AbortError");

    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        fetchImpl: async () => {
          throw abortError;
        },
      }),
    ).rejects.toBe(abortError);
  });

  it("replaces an ordinary fetch failure after signal abort with a safe AbortError", async () => {
    const controller = new AbortController();
    const sensitivePrefix = "sensitive-fetch-prefix";
    const original = new Error(`${sensitivePrefix}: request failed`);
    controller.abort();

    let error: unknown;
    try {
      await discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        signal: controller.signal,
        fetchImpl: async () => {
          throw original;
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBe(original);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain(sensitivePrefix);
  });

  it("rethrows AbortError raised while reading the response body", async () => {
    const abortError = new DOMException(
      "test body abort",
      "AbortError",
    );

    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        fetchImpl: async () =>
          ({
            ok: true,
            json: async () => {
              throw abortError;
            },
          }) as unknown as Response,
      }),
    ).rejects.toBe(abortError);
  });

  it("sanitizes a sensitive body SyntaxError when the signal is already aborted", async () => {
    const controller = new AbortController();
    const sensitivePrefix = "sensitive-body-prefix";
    const original = new SyntaxError(
      `${sensitivePrefix}: malformed response`,
    );
    controller.abort();

    let error: unknown;
    try {
      await discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        signal: controller.signal,
        fetchImpl: async () =>
          ({
            ok: true,
            json: async () => {
              throw original;
            },
          }) as unknown as Response,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBe(original);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain(sensitivePrefix);
  });

  it("keeps a non-aborted malformed response on the safe parse error", async () => {
    const sensitivePrefix = "sensitive-nonabort-prefix";
    let error: unknown;

    try {
      await discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        fetchImpl: async () =>
          ({
            ok: true,
            json: async () => {
              throw new SyntaxError(
                `${sensitivePrefix}: malformed response`,
              );
            },
          }) as unknown as Response,
      });
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain("无法解析");
    expect(String(error)).not.toContain(sensitivePrefix);
  });

  it("lists models using bearer authentication but never returns the key", async () => {
    const requests: Request[] = [];
    const models = await discoverModels({
      baseUrl: "https://api.example.com/v1",
      apiKey: "private-test-key",
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          data: [{ id: "code-large" }, { id: "chat-small" }],
        });
      },
    });

    expect(models).toEqual([
      { id: "code-large", label: "code-large" },
      { id: "chat-small", label: "chat-small" },
    ]);
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer private-test-key",
    );
    expect(JSON.stringify(models)).not.toContain("private-test-key");
  });

  it("rejects non-HTTPS remote model-list URLs", async () => {
    await expect(
      discoverModels({
        baseUrl: "http://api.example.com/v1",
        apiKey: "private-test-key",
        fetchImpl: fetch,
      }),
    ).rejects.toThrow("HTTPS");
  });

  it("allows the explicit localhost HTTP exception", async () => {
    let requestedUrl = "";
    await discoverModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return Response.json({ data: [{ id: "qwen-coder" }] });
      },
    });

    expect(requestedUrl).toBe("http://127.0.0.1:11434/v1/models");
  });

  it.each<Record<string, string>>([
    { Authorization: "attacker-controlled" },
    { "X-Team": "one", "x-team": "two" },
  ])("rejects unsafe discovery headers: %#", async (headers) => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "private-test-key",
        headers,
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes status and parse failures without response or credential details", async () => {
    const sensitive =
      "private-test-key raw-response sensitive-response-header";
    for (const response of [
      new Response(`raw-response ${sensitive}`, {
        status: 503,
        headers: { "x-sensitive": sensitive },
      }),
      new Response(`not-json ${sensitive}`, {
        status: 200,
        headers: { "x-sensitive": sensitive },
      }),
    ]) {
      let error: unknown;
      try {
        await discoverModels({
          baseUrl: "https://api.example.com/v1",
          apiKey: "private-test-key",
          fetchImpl: async () => response,
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).not.toContain("private-test-key");
      expect(String(error)).not.toContain("raw-response");
      expect(String(error)).not.toContain("sensitive-response-header");
    }
  });

  it("returns only model IDs within the 1–200 character boundary", async () => {
    const models = await discoverModels({
      baseUrl: "https://api.example.com/v1",
      apiKey: "private-test-key",
      fetchImpl: async () =>
        Response.json({
          data: [
            { id: "" },
            { id: "x".repeat(201) },
            { id: "valid-model" },
            { id: 42 },
            { name: "missing-id" },
          ],
        }),
    });

    expect(models).toEqual([
      { id: "valid-model", label: "valid-model" },
    ]);
  });

  it("ranks preferred coding models before applying the 500-model cap", async () => {
    const genericModels = Array.from({ length: 500 }, (_, index) => ({
      id: `chat-${index}`,
    }));

    const models = await discoverModels({
      baseUrl: "https://api.example.com/v1",
      apiKey: "private-test-key",
      fetchImpl: async () =>
        Response.json({
          data: [...genericModels, { id: "qwen-coder-late" }],
        }),
    });

    expect(models).toHaveLength(500);
    expect(models[0]).toEqual({
      id: "qwen-coder-late",
      label: "qwen-coder-late",
    });
  });
});
