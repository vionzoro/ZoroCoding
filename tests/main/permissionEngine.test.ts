import {
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionEngine } from "../../src/main/tools/permissionEngine";

describe("PermissionEngine", () => {
  let sandbox: string;
  let project: string;
  let outside: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "zorocoding-permission-"));
    project = join(sandbox, "project");
    outside = join(sandbox, "outside");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(project, "src", "safe.ts"), "export const safe = true;");
    await writeFile(join(outside, "secret.txt"), "not for the project");
    await symlink(outside, join(project, "escape"));
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(sandbox, { recursive: true, force: true });
  });

  it("allows ordinary reads contained by the canonical project root", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "read_file", path: join(project, "src", "safe.ts") },
      project,
    );

    expect(decision.level).toBe("allow");
    expect(decision.reasons).toEqual([]);
  });

  it("requires approval when a symlink resolves outside the project", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "read_file", path: join(project, "escape", "secret.txt") },
      project,
    );

    expect(decision.level).toBe("ask");
    expect(decision.reasons.join(" ")).toContain("项目");
  });

  it("requires approval for a new path outside the project", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "write_file", path: join(outside, "new", "file.txt") },
      project,
    );

    expect(decision.level).toBe("ask");
  });

  it("requires approval for delete operations inside the project", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "delete_path", path: join(project, "src", "safe.ts") },
      project,
    );

    expect(decision).toMatchObject({
      level: "ask",
      summary: expect.stringContaining("删除"),
    });
  });

  it.each([
    "rm -rf build",
    "/bin/rm -rf build",
    "sudo make install",
    "npm install -g tool",
    "brew install jq",
    "git push origin main",
    "diskutil eraseDisk APFS Empty disk4",
    "cat ~/.ssh/id_rsa",
    "cat $HOME/.ssh/id_rsa",
    "printf '%s' \"$(cat ../secret.txt)\"",
    "python -c 'import os; print(os.listdir(\"/\"))'",
    "find . -delete",
    "curl https://example.com",
    "./scripts/custom-wrapper.sh",
  ])("requires approval for %s", async (command) => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "shell", command, cwd: project },
      await realpath(project),
    );

    expect(decision.level).toBe("ask");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("allows ordinary project development commands", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "shell", command: "npm test -- --runInBand", cwd: project },
      project,
    );

    expect(decision.level).toBe("allow");
  });

  it.each([
    "npm run build",
    "npm run lint -- --fix=false",
    "pnpm test",
    "git status --short",
    "git diff -- src/App.tsx",
  ])("allows an unambiguous project command: %s", async (command) => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "shell", command, cwd: project },
      project,
    );

    expect(decision.level).toBe("allow");
  });
});
