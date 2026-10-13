import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface MockMessage {
  role?: string;
  content?: string | null;
  tool_call_id?: string;
}

interface MockRequestBody {
  model?: string;
  messages?: MockMessage[];
  tools?: Array<{
    function?: {
      name?: string;
    };
  }>;
  stream?: boolean;
}

export interface RecordedModelRequest {
  providerId: string;
  model: string;
  userPromptDigests: string[];
  quickChat: boolean;
  streamed: boolean;
  toolNames: string[];
  toolResponses: Array<{
    callId: string;
    denied: boolean;
  }>;
}

export interface MockModelServer {
  baseUrl: string;
  requests: RecordedModelRequest[];
  requestPaths: string[];
  close(): Promise<void>;
}

function readJson(request: IncomingMessage): Promise<MockRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as MockRequestBody);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sse(response: ServerResponse, chunks: string[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(chunk);
  }
  response.end();
}

function textFrame(text: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: finishReason }],
  })}\n\n`;
}

function toolFrames(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): string[] {
  const serialized = JSON.stringify(arguments_);
  const firstBoundary = Math.max(1, Math.floor(serialized.length / 3));
  const secondBoundary = Math.max(
    firstBoundary + 1,
    Math.floor((serialized.length * 2) / 3),
  );
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: {
                  name: name.slice(0, Math.max(1, Math.floor(name.length / 2))),
                  arguments: serialized.slice(0, firstBoundary),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: name.slice(Math.max(1, Math.floor(name.length / 2))),
                  arguments: serialized.slice(firstBoundary, secondBoundary),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: serialized.slice(secondBoundary),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 20,
        total_tokens: 60,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function hasPrompt(body: MockRequestBody, marker: string): boolean {
  return (body.messages ?? []).some(
    (message) =>
      typeof message.content === "string" && message.content.includes(marker),
  );
}

const READ_ONLY_DENIAL_MESSAGES = new Set([
  "只读任务不允许修改文件。",
  "只读任务不允许运行终端命令。",
]);

export async function startMockModelServer(
  options: { requireShellApproval?: boolean } = {},
): Promise<MockModelServer> {
  const requests: RecordedModelRequest[] = [];
  const failedOncePrompts = new Set<string>();

  const requestPaths: string[] = [];
  const server = createServer(async (request, response) => {
    requestPaths.push(request.url ?? "");
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== "Bearer e2e-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid API key" } }));
      return;
    }

    const body = await readJson(request);
    const providerMarker = request.headers["x-zoro-e2e-provider"];
    requests.push({
      providerId:
        providerMarker === "e2e-groq" ||
        providerMarker === "e2e-kimi-k3"
          ? providerMarker
          : "unknown",
      model: body.model ?? "",
      userPromptDigests: (body.messages ?? []).flatMap((message) =>
        message.role === "user" && typeof message.content === "string"
          ? [
              createHash("sha256")
                .update(message.content, "utf8")
                .digest("hex"),
            ]
          : [],
      ),
      quickChat: hasPrompt(body, "ZoroCoding 快速问答助手"),
      streamed: body.stream === true,
      toolNames: (body.tools ?? []).flatMap((tool) =>
        typeof tool.function?.name === "string"
          ? [tool.function.name]
          : [],
      ),
      toolResponses: (body.messages ?? []).flatMap((message) =>
        message.role === "tool" &&
        typeof message.tool_call_id === "string" &&
        typeof message.content === "string"
          ? [
              {
                callId: message.tool_call_id,
                denied: READ_ONLY_DENIAL_MESSAGES.has(message.content),
              },
            ]
          : [],
      ),
    });

    if (hasPrompt(body, "[mock:delay]")) {
      const timer = setTimeout(() => {
        if (!response.writableEnded) {
          sse(response, [textFrame("延迟响应", "stop"), "data: [DONE]\n\n"]);
        }
      }, 60_000);
      request.once("aborted", () => clearTimeout(timer));
      response.once("close", () => clearTimeout(timer));
      return;
    }

    if (hasPrompt(body, "[mock:fail-always]")) {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify({ error: { message: "forced failure" } }));
      return;
    }

    const failOncePrompt = (body.messages ?? [])
      .map((message) => message.content ?? "")
      .find((content) => content.includes("[mock:fail-once]"));
    if (
      failOncePrompt !== undefined &&
      !failedOncePrompts.has(failOncePrompt)
    ) {
      failedOncePrompts.add(failOncePrompt);
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify({ error: { message: "retry once" } }));
      return;
    }

    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }),
      );
      return;
    }

    const isQuickChat = hasPrompt(body, "ZoroCoding 快速问答助手");
    if (isQuickChat) {
      const modelCopy = body.model?.includes("light")
        ? "轻量问答已完成。"
        : "高级问答已完成。";
      sse(response, [
        textFrame(modelCopy, "stop"),
        "data: [DONE]\n\n",
      ]);
      return;
    }

    if ((body.tools ?? []).length === 0) {
      sse(response, [
        textFrame(
          JSON.stringify({
            title: "更新版本并验证",
            steps: [
              {
                title: "更新版本并运行验证",
                completionCriteria: "version.txt 为 2 且命令验证通过",
                estimateSeconds: 30,
              },
            ],
          }),
          "stop",
        ),
        "data: [DONE]\n\n",
      ]);
      return;
    }

    const completedTools = (body.messages ?? []).filter(
      (message) => message.role === "tool",
    ).length;
    if (completedTools === 0) {
      sse(
        response,
        toolFrames("write-version", "write_file", {
          path: "version.txt",
          content: "2\n",
          expectedSha256: null,
        }),
      );
      return;
    }
    if (completedTools === 1) {
      sse(
        response,
        toolFrames("verify-version", "run_shell", {
          command: options.requireShellApproval
            ? "find . -maxdepth 1"
            : "pwd",
        }),
      );
      return;
    }
    sse(response, [
      textFrame("版本已经更新，终端验证通过。", "stop"),
      "data: [DONE]\n\n",
    ]);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock model server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    requestPaths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
