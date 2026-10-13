import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileTools } from "../../src/main/tools/fileTools";
import { PermissionEngine } from "../../src/main/tools/permissionEngine";
import { ShellTool } from "../../src/main/tools/shellTool";
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
      run: vi.fn(async (_options: Parameters<ShellTool["run"]>[0]) => ({
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
