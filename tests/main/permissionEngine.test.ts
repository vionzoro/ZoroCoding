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
import type {
  PermissionDecision,
  PermissionReasonCode,
} from "../../src/shared/domain";

function expectReasonCodes(
  decision: PermissionDecision,
  codes: PermissionReasonCode[],
): void {
  expect(decision.reasonCodes).toEqual(codes);
  expect(decision.reasons).toHaveLength(codes.length);
}

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
    expectReasonCodes(decision, []);
  });

  it("requires approval when a symlink resolves outside the project", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "read_file", path: join(project, "escape", "secret.txt") },
      project,
    );

    expect(decision.level).toBe("ask");
    expect(decision.reasons.join(" ")).toContain("项目");
    expectReasonCodes(decision, ["read_outside_project"]);
  });

  it("requires approval for a new path outside the project", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "write_file", path: join(outside, "new", "file.txt") },
      project,
    );

    expect(decision.level).toBe("ask");
    expectReasonCodes(decision, ["write_outside_project"]);
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
    expectReasonCodes(decision, ["delete_path"]);
  });

  it.each([
    ["rm -rf build", ["delete", "not_allowlisted"]],
    ["/bin/rm -rf build", ["not_allowlisted"]],
    ["sudo make install", ["privilege", "not_allowlisted"]],
    ["npm install -g tool", ["global_install", "not_allowlisted"]],
    ["brew install jq", ["brew_system", "not_allowlisted"]],
    ["git push origin main", ["git_publish_or_destroy", "not_allowlisted"]],
    ["diskutil eraseDisk APFS Empty disk4", ["disk", "not_allowlisted"]],
    ["cat ~/.ssh/id_rsa", ["not_allowlisted"]],
    ["cat $HOME/.ssh/id_rsa", ["not_allowlisted"]],
    ["printf '%s' \"$(cat ../secret.txt)\"", ["not_allowlisted"]],
    ["python -c 'import os; print(os.listdir(\"/\"))'", ["not_allowlisted"]],
    ["find . -delete", ["not_allowlisted"]],
    ["curl https://example.com", ["not_allowlisted"]],
    ["./scripts/custom-wrapper.sh", ["not_allowlisted"]],
    ["reboot", ["system_state", "not_allowlisted"]],
    ["pip install --user tool", ["pip_outside", "not_allowlisted"]],
    ["cat /etc/hosts", ["system_path", "not_allowlisted"]],
    ["pwd > ../output.txt", ["redirect_outside_project", "not_allowlisted"]],
  ] satisfies Array<[string, PermissionReasonCode[]]>)(
    "requires approval for %s",
    async (command, codes) => {
      const engine = new PermissionEngine();

      const decision = await engine.assess(
        { kind: "shell", command },
        await realpath(project),
      );

      expect(decision.level).toBe("ask");
      expect(decision.reasons.length).toBeGreaterThan(0);
      expectReasonCodes(decision, codes);
    },
  );

  it("allows ordinary project development commands", async () => {
    const engine = new PermissionEngine();

    const decision = await engine.assess(
      { kind: "shell", command: "npm test -- --runInBand" },
      project,
    );

    expect(decision.level).toBe("allow");
    expectReasonCodes(decision, ["package_script"]);
  });

  it.each([
    ["npm run build", ["package_script"]],
    ["npm run lint -- --fix=false", ["package_script"]],
    ["pnpm test", ["package_script"]],
    ["git status --short", []],
    ["git diff -- src/App.tsx", []],
  ] satisfies Array<[string, PermissionReasonCode[]]>)(
    "allows an unambiguous project command: %s",
    async (command, codes) => {
      const engine = new PermissionEngine();

      const decision = await engine.assess(
        { kind: "shell", command },
        project,
      );

      expect(decision.level).toBe("allow");
      expectReasonCodes(decision, codes);
    },
  );

  it.each(["default", "strict"] as const)(
    "reports package scripts under the %s profile",
    async (profile) => {
      const engine = new PermissionEngine({ profile });

      const decision = await engine.assess(
        { kind: "shell", command: "npm run clean" },
        project,
      );

      expect(decision.level).toBe(profile === "strict" ? "ask" : "allow");
      expectReasonCodes(decision, ["package_script"]);
      expect(decision.reasons).toEqual(["命令会执行项目软件包脚本"]);
    },
  );

  it.each(["default", "strict"] as const)(
    "reports mutating Git flags under the %s profile",
    async (profile) => {
      const engine = new PermissionEngine({ profile });

      const decision = await engine.assess(
        { kind: "shell", command: "git branch -D obsolete" },
        project,
      );

      expect(decision.level).toBe(profile === "strict" ? "ask" : "allow");
      expectReasonCodes(decision, ["git_mutating_flag"]);
      expect(decision.reasons).toEqual([
        "命令包含会修改 Git 状态或写入文件的选项",
      ]);
    },
  );

  it.each(["npm run clean", "git branch -D obsolete"])(
    "keeps %s automatic with no options",
    async (command) => {
      const decision = await new PermissionEngine().assess(
        { kind: "shell", command },
        project,
      );

      expect(decision.level).toBe("allow");
      expectReasonCodes(decision, [
        command.startsWith("npm") ? "package_script" : "git_mutating_flag",
      ]);
    },
  );

  it.each(["git status --short", "git branch --list", "pwd"])(
    "allows read-only commands under the strict profile: %s",
    async (command) => {
      const decision = await new PermissionEngine({ profile: "strict" }).assess(
        { kind: "shell", command },
        project,
      );

      expect(decision.level).toBe("allow");
      expectReasonCodes(decision, []);
    },
  );

  it.each([
    "git branch --delete obsolete",
    "git branch -m old new",
    "git branch --set-upstream-to=origin/main",
    "git diff --output=changes.patch",
  ])("requires approval for mutating Git options in strict mode: %s", async (command) => {
    const decision = await new PermissionEngine({ profile: "strict" }).assess(
      { kind: "shell", command },
      project,
    );

    expect(decision.level).toBe("ask");
    expectReasonCodes(decision, ["git_mutating_flag"]);
  });

  it("keeps existing risks requiring approval alongside informational codes", async () => {
    const decision = await new PermissionEngine().assess(
      { kind: "shell", command: "npm run clean -- --global" },
      project,
    );

    expect(decision.level).toBe("ask");
    expectReasonCodes(decision, ["global_install", "package_script"]);
    expect(decision.reasons).toEqual([
      "命令会全局安装软件包",
      "命令会执行项目软件包脚本",
    ]);
  });

  it("keeps multiple codes and reasons index-aligned without duplicates", async () => {
    const decision = await new PermissionEngine().assess(
      {
        kind: "shell",
        command: "sudo rm /etc/file; sudo rm /etc/other > ../output",
      },
      project,
    );

    expect(decision.level).toBe("ask");
    expectReasonCodes(decision, [
      "privilege",
      "delete",
      "system_path",
      "redirect_outside_project",
      "not_allowlisted",
    ]);
    expect(decision.reasons).toEqual([
      "命令请求管理员权限",
      "命令会删除文件或目录",
      "命令访问 macOS 系统或全局目录",
      "命令会把输出写到项目目录之外",
      "命令不在自动执行白名单内，或包含复杂 Shell 语法",
    ]);
  });

  it("reports both outside-project and deletion reasons", async () => {
    const decision = await new PermissionEngine().assess(
      { kind: "delete_path", path: join(outside, "secret.txt") },
      project,
    );

    expect(decision.level).toBe("ask");
    expectReasonCodes(decision, ["write_outside_project", "delete_path"]);
    expect(decision.reasons).toEqual([
      "目标路径位于当前项目目录之外",
      "该操作会删除文件或目录",
    ]);
  });

  it.each(["read_file", "write_file", "delete_path"] as const)(
    "denies %s under a configured protected root through a symlink",
    async (kind) => {
      const decision = await new PermissionEngine({
        protectedRoots: [outside],
      }).assess({ kind, path: join(project, "escape", "secret.txt") }, project);

      expect(decision.level).toBe("deny");
      expect(decision.canonicalTarget).toBe(
        await realpath(join(outside, "secret.txt")),
      );
      expectReasonCodes(decision, [
        "system_path",
        kind === "read_file" ? "read_outside_project" : "write_outside_project",
        ...(kind === "delete_path" ? ["delete_path" as const] : []),
      ]);
      expect(decision.reasons[0]).toBe("目标路径位于受保护目录内");
    },
  );

  it("denies new paths under a protected root inside the project", async () => {
    const decision = await new PermissionEngine({
      protectedRoots: ["src"],
    }).assess({ kind: "write_file", path: "src/new/file.ts" }, project);

    expect(decision.level).toBe("deny");
    expectReasonCodes(decision, ["system_path"]);
  });

  it("canonicalizes protected root aliases and matches the root itself", async () => {
    const decision = await new PermissionEngine({
      protectedRoots: ["escape"],
    }).assess({ kind: "delete_path", path: outside }, project);

    expect(decision.level).toBe("deny");
    expectReasonCodes(decision, [
      "system_path", "write_outside_project", "delete_path",
    ]);
  });

  it("does not treat sibling path prefixes as protected", async () => {
    const decision = await new PermissionEngine({
      protectedRoots: ["src"],
    }).assess({ kind: "write_file", path: "src-copy/file.ts" }, project);

    expect(decision.level).toBe("allow");
    expectReasonCodes(decision, []);
  });

  it("uses all configured roots and protects roots that do not yet exist", async () => {
    const decision = await new PermissionEngine({
      protectedRoots: ["other", "new/protected"],
    }).assess({ kind: "write_file", path: "new/protected/file.ts" }, project);

    expect(decision.level).toBe("deny");
    expectReasonCodes(decision, ["system_path"]);
  });
});
