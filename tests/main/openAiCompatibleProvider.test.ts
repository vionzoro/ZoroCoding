import { describe, expect, it } from "vitest";

import {
  ModelProviderError,
  OpenAiCompatibleProvider,
} from "../../src/main/models/openAiCompatibleProvider";
import type {
  ModelEvent,
  ModelRequest,
} from "../../src/main/models/types";

const request: ModelRequest = {
  messages: [{ role: "user", content: "读取 src/App.tsx" }],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取项目文件",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
};

function streamResponse(chunks: string[], status = 200, headers = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status, headers },
  );
}

async function collect(
  stream: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function provider(fetchImpl: typeof fetch) {
  return new OpenAiCompatibleProvider(
    {
      id: "provider-1",
      name: "团队模型",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "team-code",
      contextLength: 128_000,
      headers: {},
      secretRef: "provider/provider-1",
      keySuffix: "alue",
      isDefault: false,
      connectionStatus: "untested",
      connectionMessage: null,
      lastTestedAt: null,
      billingNote: "",
      dashboardUrl: "",
      createdAt: 1,
      updatedAt: 1,
    },
    "secret-value",
    fetchImpl,
  );
}

describe("OpenAiCompatibleProvider", () => {
  it("streams text and combines fragmented tool-call arguments", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"正在读取"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"src/App.tsx\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = (async () =>
      streamResponse([
        frames[0].slice(0, 27),
        frames[0].slice(27) + frames[1] + frames[2].slice(0, 19),
        frames[2].slice(19) + frames[3] + frames[4],
      ])) as typeof fetch;

    const events = await collect(provider(fetchImpl).stream(request));

    expect(events).toContainEqual({
      type: "text_delta",
      text: "正在读取",
    });
    expect(events).toContainEqual({
      type: "tool_call",
      call: {
        id: "call-1",
        name: "read_file",
        arguments: '{"path":"src/App.tsx"}',
      },
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    });
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "tool_calls",
    });
  });

  it("normalizes authentication failures without exposing the API key", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"bad secret-value"}}', {
        status: 401,
      })) as typeof fetch;

    const failure = await collect(provider(fetchImpl).stream(request)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect((failure as ModelProviderError).failure).toMatchObject({
      code: "auth",
      retryable: false,
    });
    expect((failure as Error).message).not.toContain("secret-value");
  });

  it("preserves retry timing for rate limits", async () => {
    const fetchImpl = (async () =>
      new Response("limited", {
        status: 429,
        headers: { "retry-after": "3" },
      })) as typeof fetch;

    const failure = await collect(provider(fetchImpl).stream(request)).catch(
      (error: unknown) => error,
    );

    expect((failure as ModelProviderError).failure).toEqual({
      code: "rate_limited",
      message: "模型服务请求过于频繁，请稍后重试。",
      retryable: true,
      retryAfterMs: 3_000,
    });
  });
});
