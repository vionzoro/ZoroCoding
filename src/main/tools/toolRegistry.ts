import { resolve } from "node:path";
import { z } from "zod";

import type {
  PermissionDecision,
  ToolCall,
  ToolOperation,
  ToolResult,
} from "../../shared/domain";
import type { TaskExecutionMode } from "../../shared/taskRouting";
import {
  TOOL_NAME_VALUES,
  type ToolName,
} from "../../shared/toolNames";
import type { ModelToolDefinition } from "../models/types";
import {
  FileTools,
  PathOutsideProjectError,
} from "./fileTools";
import { PermissionEngine } from "./permissionEngine";
import { ShellTool } from "./shellTool";

type ApprovalRequester = (
  decision: PermissionDecision,
  operation: ToolOperation,
) => Promise<boolean>;

export interface Authorization {
  allowed: boolean;
  consent: "auto" | "human";
  sandbox: "project" | "none";
  decision: PermissionDecision;
}

// Preserve the existing execution behavior unless a profile is explicitly supplied.
export type SandboxProfile = Readonly<
  Record<Authorization["consent"], Authorization["sandbox"]>
>;

const COMPATIBILITY_SANDBOX_PROFILE: SandboxProfile = {
  auto: "project",
  human: "none",
};

const listArguments = z.object({ path: z.string().min(1).optional() });
const readArguments = z.object({ path: z.string().min(1) });
const searchArguments = z.object({ query: z.string().min(1) });
const writeArguments = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedSha256: z.string().length(64).nullable(),
});
const shellArguments = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

const TOOL_DEFINITIONS: Record<ToolName, ModelToolDefinition> = {
  list_files:
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前项目中的文件和目录，不返回文件内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "读取当前项目中的 UTF-8 文本文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  search_files: {
    type: "function",
    function: {
      name: "search_files",
      description: "在当前项目中搜索文本，忽略依赖和构建输出。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "以原子方式写入项目文件，并检查读取后的内容冲突。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedSha256: { type: ["string", "null"] },
        },
        required: ["path", "content", "expectedSha256"],
        additionalProperties: false,
      },
    },
  },
  run_shell: {
    type: "function",
    function: {
      name: "run_shell",
      description: "在当前项目中运行终端命令并返回输出。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
};

const ALL_DEFINITIONS = TOOL_NAME_VALUES.map(
  (name) => TOOL_DEFINITIONS[name],
);

const READ_ONLY_TOOL_NAMES = new Set<ToolName>([
  "list_files",
  "read_file",
  "search_files",
]);

export class ToolRegistry {
  readonly definitions: ModelToolDefinition[];

  constructor(
    private readonly projectRoot: string,
    private readonly executionMode: TaskExecutionMode,
    private readonly files: FileTools,
    private readonly shell: ShellTool,
    private readonly permissions: PermissionEngine,
    private readonly requestApproval: ApprovalRequester,
    private readonly abortController: AbortController = new AbortController(),
    private readonly sandboxProfile: SandboxProfile = COMPATIBILITY_SANDBOX_PROFILE,
  ) {
    this.definitions =
      executionMode === "read_only"
        ? ALL_DEFINITIONS.filter(({ function: tool }) =>
            READ_ONLY_TOOL_NAMES.has(tool.name as ToolName),
          )
        : [...ALL_DEFINITIONS];
  }

  async execute(
    call: ToolCall,
    onOutput?: (output: {
      stream: "stdout" | "stderr";
      text: string;
    }) => void,
  ): Promise<ToolResult> {
    if (
      this.executionMode === "read_only" &&
      (call.name === "write_file" || call.name === "run_shell")
    ) {
      return this.denied(
        call,
        call.name === "run_shell"
          ? "只读任务不允许运行终端命令。"
          : "只读任务不允许修改文件。",
      );
    }

    try {
      this.throwIfAborted();
      switch (call.name) {
        case "list_files": {
          const arguments_ = listArguments.parse(call.arguments);
          const paths = await this.files.list(arguments_.path);
          this.throwIfAborted();
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: JSON.stringify(paths),
            data: { entryCount: paths.length },
          };
        }
        case "read_file": {
          const arguments_ = readArguments.parse(call.arguments);
          let approved:
            | {
                kind: "read_file";
                canonicalPath: string;
              }
            | undefined;
          if (this.executionMode === "agentic") {
            const operation: ToolOperation = {
              kind: "read_file",
              path: resolve(this.projectRoot, arguments_.path),
            };
            const authorization = await this.authorize(operation);
            this.throwIfAborted();
            if (!authorization.allowed) {
              return this.denied(call, "用户未批准读取该路径。");
            }
            approved =
              authorization.consent === "auto" ||
              authorization.decision.canonicalTarget === undefined
                ? undefined
                : {
                    kind: "read_file",
                    canonicalPath:
                      authorization.decision.canonicalTarget,
                  };
          }
          let result;
          try {
            result = await this.files.read(arguments_.path, approved);
          } catch (error) {
            if (
              this.executionMode === "read_only" &&
              error instanceof PathOutsideProjectError
            ) {
              return this.denied(
                call,
                "只读任务不允许读取项目目录之外的文件。",
              );
            }
            throw error;
          }
          this.throwIfAborted();
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: result.content,
            data: {
              sha256: result.sha256,
              mtimeMs: result.mtimeMs,
              path: arguments_.path,
            },
          };
        }
        case "search_files": {
          const arguments_ = searchArguments.parse(call.arguments);
          const matches = await this.files.search(arguments_.query);
          this.throwIfAborted();
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: JSON.stringify(matches),
            data: { matchCount: matches.length },
          };
        }
        case "write_file": {
          const arguments_ = writeArguments.parse(call.arguments);
          const operation: ToolOperation = {
            kind: "write_file",
            path: resolve(this.projectRoot, arguments_.path),
          };
          const authorization = await this.authorize(operation);
          this.throwIfAborted();
          if (!authorization.allowed) {
            return this.denied(call, "用户未批准修改该路径。");
          }
          const result = await this.files.writeAtomic(
            arguments_.path,
            arguments_.content,
            arguments_.expectedSha256,
            authorization.consent === "auto" ||
              authorization.decision.canonicalTarget === undefined
              ? undefined
              : {
                  kind: "write_file",
                  canonicalPath: authorization.decision.canonicalTarget,
                },
          );
          this.throwIfAborted();
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: result.patch,
            data: {
              path: result.path,
              beforeSha256: result.beforeSha256,
              afterSha256: result.afterSha256,
            },
          };
        }
        case "run_shell": {
          const arguments_ = shellArguments.parse(call.arguments);
          const operation: ToolOperation = {
            kind: "shell",
            command: arguments_.command,
            cwd: await this.shell.resolveCwd(arguments_.cwd),
          };
          const authorization = await this.authorize(operation);
          this.throwIfAborted();
          if (!authorization.allowed) {
            return this.denied(call, "用户未批准运行该命令。");
          }
          const result = await this.shell.run({
            executionId: call.id,
            command: arguments_.command,
            cwd: operation.cwd,
            sandboxed: authorization.sandbox === "project",
            signal: this.abortController.signal,
            onChunk: (chunk) =>
              onOutput?.({ stream: chunk.stream, text: chunk.text }),
          });
          this.throwIfAborted();
          return {
            callId: call.id,
            name: call.name,
            ok: result.exitCode === 0,
            content: result.output,
            data: {
              exitCode: result.exitCode,
              signal: result.signal,
              durationMs: result.durationMs,
              canceled: result.canceled,
            },
          };
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        content:
          error instanceof Error ? error.message : "工具执行时发生未知错误。",
      };
    }
  }

  async cancelAll(): Promise<void> {
    this.abortController.abort();
    await this.shell.cancelAll();
  }

  private async authorize(
    operation: ToolOperation,
  ): Promise<Authorization> {
    const decision = await this.permissions.assess(
      operation,
      this.projectRoot,
    );
    const consent = decision.level === "allow" ? "auto" : "human";
    const sandbox = this.sandboxProfile[consent];
    if (decision.level === "deny") {
      return { allowed: false, consent, sandbox, decision };
    }
    return {
      allowed:
        consent === "auto" || await this.requestApproval(decision, operation),
      consent,
      sandbox,
      decision,
    };
  }

  private denied(call: ToolCall, content: string): ToolResult {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      denied: true,
      content,
    };
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }
}
