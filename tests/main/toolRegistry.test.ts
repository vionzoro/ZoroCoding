import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileTools } from "../../src/main/tools/fileTools";
import { PermissionEngine } from "../../src/main/tools/permissionEngine";
import { ShellTool, type ShellRunOptions } from "../../src/main/tools/shellTool";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { TOOL_NAME_VALUES } from "../../src/shared/toolNames";
import type { TaskExecutionMode } from "../../src/shared/taskRouting";

describe("ToolRegistry authorization", () => {
  let sandbox: string;
  let project: string;
  let outside: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "zorocoding-registry-"));
    project = join(sandbox, "project");
    outside = join(sandbox, "outside.txt");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(project);
    await writeFile(outside, "outside\n");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  function fakeShell() {
    return {
      resolveCwd: (cwd?: string) => new ShellTool(project).resolveCwd(cwd),
      run: vi.fn(async (_options: ShellRunOptions) => ({
        exitCode: 0,
        signal: null,
        durationMs: 1,
        output: "ok",
        canceled: false,
      })),
      cancelAll: vi.fn(async () => {}),
    };
  }

  function registry(
    executionMode: TaskExecutionMode,
    approval = vi.fn(async () => false),
  ) {
    const shell = fakeShell();
    const files = new FileTools(project);
    const permissions = new PermissionEngine();
    return {
      approval,
      files,
      permissions,
      registry: new ToolRegistry(
        project,
        executionMode,
        files,
        shell as unknown as ShellTool,
        permissions,
        approval,
      ),
      shell,
    };
  }

  it("advertises only inspection tools in read-only mode and all project tools in agentic mode", () => {
    const readOnly = registry("read_only").registry;
    const agentic = registry("agentic").registry;

    expect(readOnly.definitions.map((item) => item.function.name)).toEqual([
      "list_files",
      "read_file",
      "search_files",
    ]);
    expect(agentic.definitions.map((item) => item.function.name)).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "write_file",
      "run_shell",
    ]);
  });

  it("advertises every canonical tool name exactly once", () => {
    const agentic = registry("agentic").registry;

    expect(agentic.definitions.map((item) => item.function.name)).toEqual(
      [...TOOL_NAME_VALUES],
    );
  });

  it("denies forged write and shell calls in read-only mode before parsing or consulting dependencies", async () => {
    const built = registry("read_only");
    const write = vi.spyOn(built.files, "writeAtomic");
    const assess = vi.spyOn(built.permissions, "assess");

    const writeResult = await built.registry.execute({
      id: "forged-write",
      name: "write_file",
      arguments: {},
    });
    const shellResult = await built.registry.execute({
      id: "forged-shell",
      name: "run_shell",
      arguments: {},
    });

    expect(writeResult).toMatchObject({ ok: false, denied: true });
    expect(shellResult).toMatchObject({ ok: false, denied: true });
    expect(built.approval).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(built.shell.run).not.toHaveBeenCalled();
  });

  it("does not offer approval for an outside-project read in read-only mode", async () => {
    const approval = vi.fn(async () => true);
    const built = registry("read_only", approval);

    const result = await built.registry.execute({
      id: "readonly-outside-read",
      name: "read_file",
      arguments: { path: outside },
    });

    expect(result).toMatchObject({ ok: false, denied: true });
    expect(approval).not.toHaveBeenCalled();
  });

  it("returns only project-relative paths from list_files", async () => {
    await writeFile(join(project, "visible.txt"), "secret contents\n");
    const built = registry("read_only");

    const result = await built.registry.execute({
      id: "list-project",
      name: "list_files",
      arguments: {},
    });

    expect(result).toMatchObject({
      ok: true,
      content: JSON.stringify(["visible.txt"]),
      data: { entryCount: 1 },
    });
    expect(result.content).not.toContain("secret contents");
  });

  it("runs automatically allowed commands inside the OS sandbox", async () => {
    const shell = fakeShell();
    const registry = new ToolRegistry(
      project,
      "agentic",
      new FileTools(project),
      shell as unknown as ShellTool,
      new PermissionEngine(),
      async () => false,
    );

    const result = await registry.execute({
      id: "safe-shell",
      name: "run_shell",
      arguments: { command: "npm test" },
    });

    expect(result.ok).toBe(true);
    expect(shell.run).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxed: true }),
    );
  });

  it("runs an ambiguous command only after approval and outside the automatic sandbox", async () => {
    const shell = fakeShell();
    const approve = vi.fn(async () => true);
    const registry = new ToolRegistry(
      project,
      "agentic",
      new FileTools(project),
      shell as unknown as ShellTool,
      new PermissionEngine(),
      approve,
    );

    const result = await registry.execute({
      id: "approved-shell",
      name: "run_shell",
      arguments: { command: "python -c 'print(1)'" },
    });

    expect(result.ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(shell.run).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxed: false }),
    );
  });

  it("uses the explicit sandbox profile even when approval metadata requests no sandbox", async () => {
    const shell = fakeShell();
    const permissions = new PermissionEngine();
    const decision = {
      level: "ask" as const,
      summary: "确认运行命令",
      reasons: [],
      sandbox: "none",
    };
    vi.spyOn(permissions, "assess").mockResolvedValue(decision);
    const approve = vi.fn(async () => true);
    const registry = new ToolRegistry(
      project,
      "agentic",
      new FileTools(project),
      shell as unknown as ShellTool,
      permissions,
      approve,
      new AbortController(),
      { auto: "project", human: "project" },
    );

    const result = await registry.execute({
      id: "sandboxed-approval",
      name: "run_shell",
      arguments: { command: "printf ok" },
    });

    expect(result.ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(shell.run).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxed: true }),
    );
  });

  it.each([undefined, ".", "..", "escape"])(
    "passes the canonical cwd to assessment for %s",
    async (cwd) => {
      await symlink(sandbox, join(project, "escape"));
      const built = registry("agentic");
      const assess = vi.spyOn(built.permissions, "assess").mockResolvedValue({
        level: "deny",
        summary: "拒绝运行命令",
        reasons: [],
      });
      const canonicalCwd = await realpath(
        cwd === undefined || cwd === "." ? project : sandbox,
      );

      const result = await built.registry.execute({
        id: "cwd-assessment",
        name: "run_shell",
        arguments: { command: "pwd", cwd },
      });

      expect(result).toMatchObject({ ok: false, denied: true });
      expect(assess).toHaveBeenCalledWith(
        { kind: "shell", command: "pwd", cwd: canonicalCwd },
        project,
      );
      expect(built.shell.run).not.toHaveBeenCalled();
    },
  );

  it("passes the assessed canonical cwd unchanged to shell execution", async () => {
    await symlink(project, join(project, "alias"));
    const built = registry("agentic");
    const assess = vi.spyOn(built.permissions, "assess");

    await built.registry.execute({
      id: "cwd-execution",
      name: "run_shell",
      arguments: { command: "pwd", cwd: "alias" },
    });

    const operation = assess.mock.calls[0][0];
    expect(operation.kind).toBe("shell");
    if (operation.kind === "shell") {
      expect(built.shell.run).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: operation.cwd }),
      );
    }
  });

  it("does not run a command when canceled during approval", async () => {
    const built = registry("agentic");
    built.approval.mockImplementation(async () => {
      await built.registry.cancelAll();
      return true;
    });

    await expect(built.registry.execute({
      id: "canceled-approval",
      name: "run_shell",
      arguments: { command: "printf ok" },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(built.shell.run).not.toHaveBeenCalled();
  });

  it("uses a narrowly approved canonical path for an outside-project read", async () => {
    const shell = fakeShell();
    const registry = new ToolRegistry(
      project,
      "agentic",
      new FileTools(project),
      shell as unknown as ShellTool,
      new PermissionEngine(),
      async () => true,
    );

    const result = await registry.execute({
      id: "outside-read",
      name: "read_file",
      arguments: { path: outside },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("outside\n");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("forwards live terminal chunks to the runtime", async () => {
    const shell = fakeShell();
    shell.run.mockImplementation(async (options) => {
      options.onChunk?.({
        stream: "stdout",
        text: "live output",
        at: Date.now(),
      });
      return {
        exitCode: 0,
        signal: null,
        durationMs: 1,
        output: "live output",
        canceled: false,
      };
    });
    const registry = new ToolRegistry(
      project,
      "agentic",
      new FileTools(project),
      shell as unknown as ShellTool,
      new PermissionEngine(),
      async () => false,
    );
    const onOutput = vi.fn();

    await registry.execute(
      {
        id: "stream-shell",
        name: "run_shell",
        arguments: { command: "npm test" },
      },
      onOutput,
    );

    expect(onOutput).toHaveBeenCalledWith({
      stream: "stdout",
      text: "live output",
    });
  });

});
