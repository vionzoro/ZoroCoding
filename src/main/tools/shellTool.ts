import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  resolve,
  sep,
} from "node:path";
import type { Readable } from "node:stream";

import {
  canonicalizePath,
  isPathContained,
} from "./permissionEngine";

const MAX_OUTPUT_BYTES = 200 * 1024;
const TERMINATION_GRACE_MS = 1_500;
const TERMINATION_KILL_WAIT_MS = 1_500;

export interface ShellChunk {
  stream: "stdout" | "stderr";
  text: string;
  at: number;
}

export interface ShellRunOptions {
  executionId: string;
  command: string;
  cwd?: string;
  sandboxed?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: ShellChunk) => void;
}

export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  output: string;
  canceled: boolean;
}

interface ActiveExecution {
  child: ShellChildProcess;
  canceled: boolean;
  closed: Promise<void>;
  markClosed: () => void;
}

type ShellChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function appendOutput(output: string, text: string): string {
  const combined = Buffer.from(output + text);
  return combined.length <= MAX_OUTPUT_BYTES
    ? combined.toString("utf8")
    : combined.subarray(combined.length - MAX_OUTPUT_BYTES).toString("utf8");
}

function sanitizedEnvironment(
  isolatedHome?: string,
): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "TMPDIR",
    "TERM",
  ] as const;
  return {
    ...Object.fromEntries(
    allowed.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
    ),
    HOME: isolatedHome ?? process.env.HOME,
    TMPDIR:
      isolatedHome === undefined
        ? process.env.TMPDIR
        : resolve(isolatedHome, "tmp"),
    XDG_CACHE_HOME:
      isolatedHome === undefined
        ? undefined
        : resolve(isolatedHome, "cache"),
    XDG_CONFIG_HOME:
      isolatedHome === undefined
        ? undefined
        : resolve(isolatedHome, "config"),
    ZDOTDIR: isolatedHome ?? "/var/empty",
  };
}

function sandboxLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export interface SandboxReadRule {
  kind: "literal" | "subpath";
  path: string;
}

export function buildShellSandboxProfile(
  projectRoot: string,
  isolatedHome: string,
  toolchainRules: SandboxReadRule[] = [],
): string {
  const readableRoots = [
    projectRoot,
    isolatedHome,
    "/System",
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/usr/sbin",
    "/bin",
    "/sbin",
  ];
  const readable = [
    ...readableRoots.map(
      (path): SandboxReadRule => ({ kind: "subpath", path }),
    ),
    { kind: "literal", path: "/dev/null" } as const,
    { kind: "literal", path: "/dev/random" } as const,
    { kind: "literal", path: "/dev/urandom" } as const,
    ...toolchainRules,
  ]
    .map(
      (rule) =>
        `(${rule.kind} "${sandboxLiteral(rule.path)}")`,
    )
    .join(" ");
  const writable = [projectRoot, isolatedHome]
    .map((path) => `(subpath "${sandboxLiteral(path)}")`)
    .join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    "(allow file-read-metadata)",
    `(allow file-read* ${readable})`,
    `(allow file-write* ${writable} (literal "/dev/null"))`,
    "(deny network*)",
  ].join("\n");
}

function packageOrRuntimeRoot(path: string): string | null {
  const nodeModulesMarker = `${sep}node_modules${sep}`;
  const nodeModulesIndex = path.lastIndexOf(nodeModulesMarker);
  if (nodeModulesIndex >= 0) {
    const packageStart = nodeModulesIndex + nodeModulesMarker.length;
    const segments = path.slice(packageStart).split(sep);
    const packageSegments = segments[0]?.startsWith("@") ? 2 : 1;
    return resolve(
      path.slice(0, packageStart),
      ...segments.slice(0, packageSegments),
    );
  }

  for (const marker of [
    `${sep}Cellar${sep}`,
    `${sep}.nvm${sep}versions${sep}node${sep}`,
    `${sep}.volta${sep}tools${sep}image${sep}node${sep}`,
  ]) {
    const index = path.indexOf(marker);
    if (index < 0) {
      continue;
    }
    const prefixEnd = index + marker.length;
    const versionEnd = path.indexOf(sep, prefixEnd);
    if (versionEnd > prefixEnd) {
      if (marker.includes(`${sep}Cellar${sep}`)) {
        const formulaEnd = versionEnd;
        const formulaVersionEnd = path.indexOf(sep, formulaEnd + 1);
        return formulaVersionEnd > formulaEnd
          ? path.slice(0, formulaVersionEnd)
          : dirname(path);
      }
      return path.slice(0, versionEnd);
    }
  }
  return null;
}

async function executableRules(name: string): Promise<SandboxReadRule[]> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      const rules: SandboxReadRule[] = [
        { kind: "literal", path: candidate },
        { kind: "literal", path: canonical },
      ];
      const runtimeRoot = packageOrRuntimeRoot(canonical);
      if (runtimeRoot !== null) {
        rules.push({ kind: "subpath", path: runtimeRoot });
      }
      return rules;
    } catch {
      // Continue searching the inherited executable path.
    }
  }
  return [];
}

async function automaticToolchainRules(
  command: string,
): Promise<SandboxReadRule[]> {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  const names = new Set([executable]);
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    names.add("node");
  }
  const rules = (await Promise.all([...names].map(executableRules))).flat();
  return [
    ...new Map(
      rules.map((rule) => [`${rule.kind}:${rule.path}`, rule]),
    ).values(),
  ];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export class ShellTool {
  private readonly canonicalProjectRoot: Promise<string>;
  private readonly active = new Map<string, ActiveExecution>();
  private cancellationEpoch = 0;

  constructor(projectRoot: string) {
    this.canonicalProjectRoot = realpath(resolve(projectRoot));
  }

  async resolveCwd(cwd?: string): Promise<string> {
    const projectRoot = await this.canonicalProjectRoot;
    return canonicalizePath(
      cwd === undefined
        ? projectRoot
        : isAbsolute(cwd)
          ? cwd
          : resolve(projectRoot, cwd),
    );
  }

  async run(options: ShellRunOptions): Promise<ShellResult> {
    const epoch = this.cancellationEpoch;
    const throwIfCanceled = () => {
      if (options.signal?.aborted || epoch !== this.cancellationEpoch) {
        throw new DOMException("Aborted", "AbortError");
      }
    };
    throwIfCanceled();
    if (this.active.has(options.executionId)) {
      throw new Error(`命令执行 ID ${options.executionId} 已存在。`);
    }
    const projectRoot = await this.canonicalProjectRoot;
    const canonicalCwd = await this.resolveCwd(options.cwd);
    if (!isPathContained(canonicalCwd, projectRoot)) {
      throw new Error("命令工作目录必须位于当前项目内。");
    }

    let isolatedHome: string | undefined;
    let startedAt: number;
    let child: ShellChildProcess;
    try {
      isolatedHome = options.sandboxed
        ? await mkdtemp(resolve(tmpdir(), "zorocoding-shell-"))
        : undefined;
      if (isolatedHome !== undefined) {
        const home = isolatedHome;
        await Promise.all(
          ["tmp", "cache", "config"].map((directory) =>
            mkdir(resolve(home, directory), { recursive: true }),
          ),
        );
      }
      const executable =
        options.sandboxed === true ? "/usr/bin/sandbox-exec" : "/bin/zsh";
      const arguments_ =
        options.sandboxed === true && isolatedHome !== undefined
          ? [
              "-p",
              buildShellSandboxProfile(
                projectRoot,
                isolatedHome,
                await automaticToolchainRules(options.command),
              ),
              "/bin/zsh",
              "-fc",
              options.command,
            ]
          : ["-lc", options.command];
      throwIfCanceled();
      startedAt = Date.now();
      child = spawn(executable, arguments_, {
        cwd: canonicalCwd,
        detached: true,
        env: sanitizedEnvironment(isolatedHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (isolatedHome !== undefined) {
        await rm(isolatedHome, { recursive: true, force: true });
      }
      throw error;
    }
    let markClosed = () => {};
    const closed = new Promise<void>((resolveClosed) => {
      markClosed = resolveClosed;
    });
    const execution: ActiveExecution = {
      child,
      canceled: false,
      closed,
      markClosed,
    };
    this.active.set(options.executionId, execution);
    let output = "";

    const emit = (stream: ShellChunk["stream"], data: Buffer) => {
      const text = data.toString("utf8");
      output = appendOutput(output, text);
      options.onChunk?.({ stream, text, at: Date.now() });
    };
    child.stdout.on("data", (data: Buffer) => emit("stdout", data));
    child.stderr.on("data", (data: Buffer) => emit("stderr", data));

    return new Promise<ShellResult>((resolveResult, reject) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.active.delete(options.executionId);
        execution.markClosed();
        void (async () => {
          try {
            if (isolatedHome !== undefined) {
              await rm(isolatedHome, { recursive: true, force: true });
            }
            reject(error);
          } catch (cleanupError) {
            reject(
              new AggregateError(
                [error, cleanupError],
                "命令启动失败，且沙箱临时目录清理失败。",
              ),
            );
          }
        })();
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        this.active.delete(options.executionId);
        execution.markClosed();
        void (async () => {
          try {
            if (isolatedHome !== undefined) {
              await rm(isolatedHome, { recursive: true, force: true });
            }
            resolveResult({
              exitCode,
              signal,
              durationMs: Date.now() - startedAt,
              output,
              canceled: execution.canceled,
            });
          } catch (cleanupError) {
            reject(
              new AggregateError(
                [cleanupError],
                "命令已结束，但沙箱临时目录清理失败。",
              ),
            );
          }
        })();
      });
    });
  }

  async cancel(executionId: string): Promise<void> {
    const execution = this.active.get(executionId);
    if (execution === undefined) {
      return;
    }
    execution.canceled = true;
    this.signalProcessGroup(execution.child, "SIGTERM");
    const closedDuringGrace = await Promise.race([
      execution.closed.then(() => true),
      wait(TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (!closedDuringGrace) {
      this.signalProcessGroup(execution.child, "SIGKILL");
      await Promise.race([
        execution.closed,
        wait(TERMINATION_KILL_WAIT_MS),
      ]);
    }
  }

  async cancelAll(): Promise<void> {
    this.cancellationEpoch += 1;
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
  }

  private signalProcessGroup(
    child: ShellChildProcess,
    signal: NodeJS.Signals,
  ): void {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          // The process may have exited between the two attempts.
        }
      }
    }
  }
}
