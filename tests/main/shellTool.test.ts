import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildShellSandboxProfile,
  ShellTool,
  type ShellChunk,
} from "../../src/main/tools/shellTool";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

const execFileAsync = promisify(execFile);

describe("ShellTool", () => {
  let project: string;
  let shell: ShellTool;

  beforeEach(async () => {
    vi.clearAllMocks();
    project = await mkdtemp(join(tmpdir(), "zorocoding-shell-"));
    shell = new ShellTool(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await shell.cancelAll();
    await rm(project, { recursive: true, force: true });
  });

  it("streams stdout and stderr and returns the exit result", async () => {
    const chunks: ShellChunk[] = [];

    const result = await shell.run({
      executionId: "streaming",
      command: "printf 'hello'; printf 'warning' >&2",
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      canceled: false,
    });
    expect(result.output).toContain("hello");
    expect(result.output).toContain("warning");
    expect(chunks.some((chunk) => chunk.stream === "stdout")).toBe(true);
    expect(chunks.some((chunk) => chunk.stream === "stderr")).toBe(true);
    expect(chunks.every((chunk) => chunk.at > 0)).toBe(true);
  });

  it("returns a nonzero exit code without throwing", async () => {
    const result = await shell.run({
      executionId: "failure",
      command: "printf 'failed' >&2; exit 7",
    });

    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("failed");
  });

  it("builds an automatic-command sandbox that blocks network and outside writes", () => {
    const profile = buildShellSandboxProfile(
      "/tmp/project with spaces",
      "/tmp/zoro-home",
    );

    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/project with spaces") (subpath "/tmp/zoro-home") (literal "/dev/null"))',
    );
    expect(profile).not.toContain('(subpath "/Library")');
    expect(profile).not.toContain('(subpath "/opt/homebrew")');
    expect(profile).not.toContain('(subpath "/dev")');
    expect(profile).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain("(allow mach-lookup)");
    expect(profile).not.toContain(process.env.HOME ?? "/Users/example");
  });

  it("prevents sandboxed processes from reading an unapproved outside file", async (context) => {
    const outside = await mkdtemp(join(tmpdir(), "zorocoding-outside-"));
    const isolatedHome = join(project, ".sandbox-home");
    const secretPath = join(outside, "secret.txt");
    await mkdir(isolatedHome, { recursive: true });
    await writeFile(secretPath, "outside-secret");
    const profile = buildShellSandboxProfile(project, isolatedHome);

    try {
      await execFileAsync("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        "/bin/cat",
        secretPath,
      ]);
      throw new Error("sandbox unexpectedly allowed the outside read");
    } catch (error) {
      const failure = error as Error & {
        stdout?: string;
        stderr?: string;
      };
      if (failure.stderr?.includes("sandbox_apply: Operation not permitted")) {
        context.skip();
        return;
      }
      expect(failure.message).not.toContain("unexpectedly allowed");
      expect(failure.stdout ?? "").not.toContain("outside-secret");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["abort", "epoch"] as const)(
    "does not spawn when %s cancellation arrives during sandbox setup",
    async (cancellation) => {
      const controller = new AbortController();
      const spawn = vi.spyOn(childProcess, "spawn");
      const createDirectory = fs.mkdir;
      let isolatedHome: string | undefined;
      vi.spyOn(fs, "mkdir").mockImplementationOnce(async (path, options) => {
        isolatedHome = join(String(path), "..");
        const result = await createDirectory(path, options);
        if (cancellation === "abort") {
          controller.abort();
        } else {
          await shell.cancelAll();
        }
        return result;
      });

      await expect(shell.run({
        executionId: "cancel-before-spawn",
        command: "pwd",
        sandboxed: true,
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });

      expect(spawn).not.toHaveBeenCalled();
      expect(isolatedHome).toBeDefined();
      await expect(fs.access(isolatedHome!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (cancellation === "epoch") {
        const result = await shell.run({
          executionId: "after-cancellation",
          command: "pwd",
        });
        expect(result.exitCode).toBe(0);
        expect(spawn).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not spawn with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.spyOn(childProcess, "spawn");

    await expect(shell.run({
      executionId: "already-aborted",
      command: "pwd",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancels the entire command process group after observable output", async () => {
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const running = shell.run({
      executionId: "cancel-me",
      command: "printf 'READY\\n'; sleep 30",
      onChunk: (chunk) => {
        if (chunk.text.includes("READY")) {
          markReady?.();
        }
      },
    });
    await ready;

    await shell.cancel("cancel-me");
    const result = await running;

    expect(result.canceled).toBe(true);
    expect(result.signal).not.toBeNull();
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
