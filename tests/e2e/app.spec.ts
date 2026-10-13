import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { promisify } from "node:util";

import { startMockModelServer } from "./fixtures/mockModelServer";

const E2E_PROVIDER_API_KEY = "e2e-key";
const execFile = promisify(execFileCallback);

function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

async function runReleaseScript(
  args: string[],
  options: {
    scriptPath?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFile(
      "/bin/zsh",
      [options.scriptPath ?? resolve("scripts/create-dmg.sh"), ...args],
      {
        encoding: "utf8",
        env: options.env ?? process.env,
        cwd: options.cwd,
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (caught) {
    const failure = caught as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function executeCommonJsFixture(source: string): string[] {
  const execution = inspectCommonJsFixture(source);
  if (execution.error !== undefined) {
    throw execution.error;
  }
  return execution.requestedModules;
}

function inspectCommonJsFixture(source: string): {
  requestedModules: string[];
  error?: unknown;
} {
  const requestedModules: string[] = [];
  const fakeRequire = (identifier: string): Record<string, never> => {
    requestedModules.push(identifier);
    return {};
  };
  const commonJsModule = {
    exports: {},
    require: fakeRequire,
  };
  const load = vm.runInNewContext(
    `(function (require, module, exports) {\n${source}\n})`,
    {},
    { filename: "preload-gate-fixture.js" },
  ) as (
    require: typeof fakeRequire,
    module: typeof commonJsModule,
    exports: Record<string, never>,
  ) => void;
  try {
    load(fakeRequire, commonJsModule, commonJsModule.exports);
    return { requestedModules };
  } catch (error) {
    return { requestedModules, error };
  }
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

interface E2eFixture {
  portableRoot: string;
  isolatedHome: string;
  dataRoot: string;
  appDataRoot: string;
  projectsRoot: string;
  fixtureProject: string;
  launchEnvironment: Record<string, string>;
  model: Awaited<ReturnType<typeof startMockModelServer>>;
}

async function createE2eFixture(): Promise<E2eFixture> {
  const portableRoot = await mkdtemp(join(tmpdir(), "zorocoding-portable-"));
  const isolatedHome = join(portableRoot, "isolated-home");
  const dataRoot = join(portableRoot, "ZoroCodingData");
  const appDataRoot = join(dataRoot, "AppData");
  const projectsRoot = join(dataRoot, "Projects");
  const fixtureProject = join(projectsRoot, "fixture");
  const model = await startMockModelServer({ requireShellApproval: true });
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(fixtureProject, { recursive: true });
  await writeFile(join(fixtureProject, "version.txt"), "1\n");

  return {
    portableRoot,
    isolatedHome,
    dataRoot,
    appDataRoot,
    projectsRoot,
    fixtureProject,
    model,
    launchEnvironment: {
      ...stringEnvironment(),
      HOME: isolatedHome,
      ZORO_E2E: "1",
      ZORO_E2E_SKIP_LIGHT_PROVIDER: "0",
      ZORO_E2E_STARTUP_DELAY_MS: "0",
      ZORO_E2E_PORTABLE_ROOT: portableRoot,
      ZORO_E2E_PROJECT_PATH: fixtureProject,
      ZORO_E2E_PROVIDER_BASE_URL: model.baseUrl,
      ZORO_E2E_PROVIDER_API_KEY: E2E_PROVIDER_API_KEY,
    },
  };
}

async function launchFixture(
  fixture: E2eFixture,
  extraEnvironment: Record<string, string> = {},
): Promise<ElectronApplication> {
  return electron.launch({
    args: [resolve("dist-electron/main/index.js")],
    env: {
      ...fixture.launchEnvironment,
      ...extraEnvironment,
    },
  });
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function closeE2eApp(app: ElectronApplication): Promise<void> {
  const process = app.process();
  const closeAttempt = app.close().catch(() => {});
  await Promise.race([closeAttempt, waitFor(2_000)]);
  if (process.exitCode !== null) {
    return;
  }
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      process.once("exit", () => resolvePromise());
    }),
    waitFor(2_000),
  ]);
  if (process.exitCode !== null) {
    return;
  }
  try {
    process.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      process.once("exit", () => resolvePromise());
    }),
    waitFor(2_000),
  ]);
}

async function disposeE2eFixture(
  fixture: E2eFixture,
  app?: ElectronApplication | null,
): Promise<void> {
  if (app !== undefined && app !== null) {
    await closeE2eApp(app);
  }
  await fixture.model.close();
  await rm(fixture.portableRoot, { recursive: true, force: true });
}

async function authorizeFixtureProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "选择项目" }).click();
  await expect(
    page.getByRole("button", { name: "选择项目" }),
  ).not.toContainText("通过 macOS 文件夹选择器授权");
}

async function startTask(
  page: Page,
  prompt: string,
  options: {
    authorizeProject?: boolean;
    manualProvider?: string;
  } = {},
): Promise<void> {
  await page.getByRole("button", { name: "发起新任务" }).click();
  if (options.authorizeProject === true) {
    await authorizeFixtureProject(page);
  }
  if (options.manualProvider !== undefined) {
    await page.getByLabel("手动选择").check();
    await page.getByRole("combobox", { name: "手动模型" }).click();
    await page
      .getByRole("option", { name: options.manualProvider })
      .click();
  }
  await page.getByLabel("任务要求").fill(prompt);
  await expect(page.getByText("实际模型：", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "开始任务" }).click();
}

async function approvedColorViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const approved = new Set(["rgb(0, 0, 0)", "rgb(201, 255, 98)"]);
    const properties = [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "outlineColor",
      "fill",
      "stroke",
    ] as const;
    const violations: string[] = [];
    for (const [index, element] of [...document.querySelectorAll("*")].entries()) {
      const style = getComputedStyle(element);
      for (const property of properties) {
        const value = style[property];
        if (
          value.length === 0 ||
          value === "none" ||
          value === "currentcolor" ||
          value === "rgba(0, 0, 0, 0)" ||
          approved.has(value)
        ) {
          continue;
        }
        violations.push(
          `${index}:${element.tagName.toLowerCase()}.${element.className}:${property}=${value}`,
        );
      }
    }
    return violations;
  });
}

test("requires the E2E provider key from an explicit environment variable", async () => {
  const mainSource = await readFile(resolve("src/main/index.ts"), "utf8");

  expect(mainSource).toContain(
    'requiredE2eValue("ZORO_E2E_PROVIDER_API_KEY")',
  );
  expect(mainSource).not.toContain('apiKey: "e2e-key"');
});

test("E2E mode seeds exact Groq and KIMI K3 routing identities", async () => {
  const mainSource = await readFile(resolve("src/main/index.ts"), "utf8");

  expect(mainSource).toContain('id: "e2e-groq"');
  expect(mainSource).toContain('name: "Groq"');
  expect(mainSource).toContain('modelId: "zoro-e2e-light"');
  expect(mainSource).toContain('id: "e2e-kimi-k3"');
  expect(mainSource).toContain('name: "KIMI K3"');
  expect(mainSource).toContain('kind: "kimi"');
  expect(mainSource).toContain('modelId: "zoro-e2e-premium"');
});

test("mock request evidence records the explicit provider independently of model ID", async () => {
  const model = await startMockModelServer();
  try {
    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${E2E_PROVIDER_API_KEY}`,
        "content-type": "application/json",
        "x-zoro-e2e-provider": "e2e-groq",
      },
      body: JSON.stringify({
        model: "zoro-e2e-premium",
        messages: [{ role: "user", content: "safe recorder probe" }],
        stream: false,
      }),
    });

    expect(response.ok).toBe(true);
    expect(model.requests).toEqual([
      expect.objectContaining({
        providerId: "e2e-groq",
        model: "zoro-e2e-premium",
        userPromptDigests: [promptDigest("safe recorder probe")],
      }),
    ]);
    expect(model.requests[0]).not.toHaveProperty("messages");
    expect(model.requests[0]).not.toHaveProperty("userPrompts");
  } finally {
    await model.close();
  }
});

test("release packaging fails closed on secrets and stale installers", async () => {
  const releaseScript = await readFile(resolve("scripts/create-dmg.sh"), "utf8");

  for (const credentialShape of [
    "kimi-generic-sk",
    "groq-gsk",
    "gemini-aq",
    "openrouter-sk-or-v1",
    "cerebras-csk",
    "nvidia-nvapi",
    "zhipu-hex-dot-suffix",
    "sambanova-uuid",
    "mistral-quoted-mixed-32",
  ]) {
    expect(releaseScript).toContain(credentialShape);
  }
  expect(releaseScript).toContain("app.asar.unpacked");
  expect(releaseScript).toContain("ls-files");
  expect(releaseScript).toContain("Stale release artifacts found");
  expect(releaseScript).toContain("ZoroCoding-安装说明.md");
  expect(releaseScript).toContain(
    "DMG staging root must contain only ZoroCoding.app and installation instructions.",
  );
  expect(releaseScript).not.toContain("ln -s /Applications");
});

test("credential fixture allowlists require the exact scan-relative path", async () => {
  const releaseScript = await readFile(resolve("scripts/create-dmg.sh"), "utf8");
  expect(releaseScript).toContain("--audit-paths");

  const fixtureName = "zorocoding-provider-settings-concept.png";
  const fixture = resolve("docs", "design", fixtureName);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zoro-audit-paths-"));
  const correctRoot = join(temporaryRoot, "correct");
  const nestedRoot = join(temporaryRoot, "nested-root");
  const unavailableTmp = join(temporaryRoot, "must-not-be-created");
  const reviewedPath = join(correctRoot, "docs", "design", fixtureName);
  const unreviewedPath = join(
    nestedRoot,
    "nested",
    "docs",
    "design",
    fixtureName,
  );

  try {
    await mkdir(join(correctRoot, "docs", "design"), { recursive: true });
    await mkdir(join(nestedRoot, "nested", "docs", "design"), {
      recursive: true,
    });
    await copyFile(fixture, reviewedPath);
    await copyFile(fixture, unreviewedPath);

    const auditEnvironment = {
      ...process.env,
      TMPDIR: unavailableTmp,
    };
    const reviewed = await runReleaseScript(["--audit-paths", correctRoot], {
      env: auditEnvironment,
    });
    expect(reviewed.exitCode).toBe(0);

    const unreviewed = await runReleaseScript(["--audit-paths", nestedRoot], {
      env: auditEnvironment,
    });
    expect(unreviewed.exitCode).not.toBe(0);
    expect(unreviewed.stderr).toContain(unreviewedPath);
    await expect(access(unavailableTmp)).rejects.toThrow();

    const fixtureText = (await readFile(fixture)).toString("utf8");
    const publicFixtureValues =
      fixtureText.match(
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
      ) ?? [];
    expect(publicFixtureValues.length).toBeGreaterThan(0);
    for (const value of publicFixtureValues) {
      expect(`${unreviewed.stdout}${unreviewed.stderr}`).not.toContain(value);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("DMG staging rejects hidden files and accepts exactly two entries", async () => {
  const releaseScript = await readFile(resolve("scripts/create-dmg.sh"), "utf8");
  expect(releaseScript).toContain("--validate-staging");

  const stagingRoot = await mkdtemp(join(tmpdir(), "zoro-staging-gate-"));
  try {
    const validRoot = join(stagingRoot, "valid");
    await mkdir(join(validRoot, "ZoroCoding.app"), { recursive: true });
    await writeFile(join(validRoot, "ZoroCoding-安装说明.md"), "说明\n");

    const valid = await runReleaseScript(["--validate-staging", validRoot]);
    expect(valid.exitCode).toBe(0);

    await writeFile(join(validRoot, ".hidden"), "must fail\n");
    const hidden = await runReleaseScript(["--validate-staging", validRoot]);
    expect(hidden.exitCode).not.toBe(0);
    expect(hidden.stderr).toContain(join(validRoot, ".hidden"));

    const targetsRoot = join(stagingRoot, "targets");
    await mkdir(join(targetsRoot, "Real.app"), { recursive: true });
    await writeFile(join(targetsRoot, "real-readme.md"), "说明\n");

    const appLinkRoot = join(stagingRoot, "app-link");
    await mkdir(appLinkRoot);
    await symlink(
      join(targetsRoot, "Real.app"),
      join(appLinkRoot, "ZoroCoding.app"),
    );
    await writeFile(join(appLinkRoot, "ZoroCoding-安装说明.md"), "说明\n");
    const appLink = await runReleaseScript([
      "--validate-staging",
      appLinkRoot,
    ]);
    expect(appLink.exitCode).not.toBe(0);

    const instructionsLinkRoot = join(stagingRoot, "instructions-link");
    await mkdir(join(instructionsLinkRoot, "ZoroCoding.app"), {
      recursive: true,
    });
    await symlink(
      join(targetsRoot, "real-readme.md"),
      join(instructionsLinkRoot, "ZoroCoding-安装说明.md"),
    );
    const instructionsLink = await runReleaseScript([
      "--validate-staging",
      instructionsLinkRoot,
    ]);
    expect(instructionsLink.exitCode).not.toBe(0);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test("release preload gate rejects local module loading", async () => {
  const isolatedProject = await mkdtemp(join(tmpdir(), "zoro-preload-gate-"));
  const callerRecoveryFixtures = [
    {
      name: "caller-arguments-require",
      source:
        '(function inner(){ inner["call" + "er"]["argu" + "ments"][0]("./local-helper"); })();\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "reflect-caller-arguments-require",
      source:
        '(function inner(){ Reflect.get(inner.caller, "argu" + "ments")[0]("./local-helper"); })();\n',
      runtimeRequests: ["./local-helper"],
    },
  ];
  const pseudoStrictCallerFixtures = [
    {
      name: "hex-escaped-strict",
      source: String.raw`"use\x20strict";
const PSEUDO_STRICT_SOURCE_MUST_NOT_ECHO = 1;
(function inner(){ inner["call" + "er"]["argu" + "ments"][0]("./local-helper"); })();
`,
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "unicode-escaped-strict",
      source: String.raw`"use\u0020strict";
const PSEUDO_STRICT_SOURCE_MUST_NOT_ECHO = 1;
(function inner(){ inner["call" + "er"]["argu" + "ments"][0]("./local-helper"); })();
`,
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "line-continuation-strict",
      source: String.raw`"use\
 strict";
const PSEUDO_STRICT_SOURCE_MUST_NOT_ECHO = 1;
(function inner(){ inner["call" + "er"]["argu" + "ments"][0]("./local-helper"); })();
`,
      runtimeRequests: ["./local-helper"],
    },
  ];
  const rawGateSourceNames = new Set([
    ...callerRecoveryFixtures.map((fixture) => fixture.name),
    "late-strict",
    "template-strict",
    "concatenated-strict",
    "parenthesized-strict",
  ]);
  const invalidFixtures: Array<{
    name: string;
    source: string;
    runtimeRequests?: string[];
  }> = [
    ...callerRecoveryFixtures,
    {
      name: "arguments-direct-require",
      source: 'arguments[0]("./local-helper");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "arguments-module-concatenated-require",
      source: 'arguments[1]["requ" + "ire"]("./local-helper");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "optional-arguments",
      source: 'arguments?.[0]?.("./local-helper");\n',
    },
    {
      name: "aliased-arguments",
      source:
        'const wrapperArguments = arguments; wrapperArguments[0]("./local-helper");\n',
    },
    {
      name: "nested-arrow-arguments",
      source: '(() => arguments[0]("./local-helper"))();\n',
    },
    {
      name: "exports-identifier",
      source: "void exports;\n",
    },
    {
      name: "exports-property",
      source: 'exports["loader"] = undefined;\n',
    },
    {
      name: "filename-identifier",
      source: "void __filename;\n",
    },
    {
      name: "dirname-identifier",
      source: "void __dirname;\n",
    },
    {
      name: "top-level-this",
      source: "void this;\n",
    },
    {
      name: "computed-this-property",
      source: 'this["requ" + "ire"]("./local-helper");\n',
    },
    {
      name: "direct-eval",
      source:
        'eval("const DYNAMIC_GATE_SOURCE_MUST_NOT_ECHO = 1; require(\\"./local-helper\\")");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "aliased-eval",
      source: 'const run = eval; run("void 0");\n',
    },
    {
      name: "indirect-eval",
      source: '(0, eval)("void 0");\n',
    },
    {
      name: "comment-separated-eval",
      source: 'eval /* gap */ ("void 0");\n',
    },
    {
      name: "optional-eval",
      source: 'eval?.("void 0");\n',
    },
    {
      name: "global-eval",
      source: 'globalThis.eval("void 0");\n',
    },
    {
      name: "optional-global-eval",
      source: 'globalThis?.eval?.("void 0");\n',
    },
    {
      name: "computed-global-eval",
      source: 'globalThis["eval"]("void 0");\n',
    },
    {
      name: "template-global-eval",
      source: 'globalThis[`eval`]("void 0");\n',
    },
    {
      name: "function-call",
      source: 'Function("return 1")();\n',
    },
    {
      name: "function-new",
      source: 'new Function("return 1")();\n',
    },
    {
      name: "comment-separated-function",
      source: 'Function /* gap */ ("return 1")();\n',
    },
    {
      name: "optional-function",
      source: 'Function?.("return 1")();\n',
    },
    {
      name: "global-function",
      source: 'globalThis.Function("return 1")();\n',
    },
    {
      name: "computed-global-function",
      source: 'globalThis["Function"]("return 1")();\n',
    },
    {
      name: "async-function-constructor",
      source: 'AsyncFunction("return 1");\n',
    },
    {
      name: "generator-function-constructor",
      source: 'GeneratorFunction("return 1");\n',
    },
    {
      name: "async-generator-function-constructor",
      source: 'AsyncGeneratorFunction("return 1");\n',
    },
    {
      name: "module-template-property",
      source: 'module[`require`]("./local-helper");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "module-concatenated-property",
      source: 'module["requ" + "ire"]("./local-helper");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "module-identifier",
      source: "void module;\n",
    },
    {
      name: "optional-module",
      source: 'module?.require?.("./local-helper");\n',
    },
    {
      name: "import-meta",
      source: "void import.meta.url;\n",
    },
    {
      name: "aliased-require",
      source: 'const r = require; r("./local-helper");\n',
    },
    {
      name: "comment-separated-require",
      source: 'require /* gap */ ("./local-helper");\n',
    },
    {
      name: "comment-separated-import",
      source: 'import /* gap */ ("./local-helper.js");\n',
    },
    {
      name: "module-require",
      source: 'module.require("./local-helper");\n',
      runtimeRequests: ["./local-helper"],
    },
    {
      name: "optional-require",
      source: 'require?.("electron");\n',
    },
    {
      name: "non-literal-require",
      source: 'const dependency = "electron"; require(dependency);\n',
    },
    {
      name: "other-module",
      source: 'require("node:fs");\n',
    },
    {
      name: "extra-require-argument",
      source: 'require("electron", "./local-helper");\n',
    },
    {
      name: "require-declaration",
      source: "const require = () => undefined;\n",
    },
    {
      name: "require-parameter",
      source: "function load(require) { return require; }\n",
    },
    {
      name: "require-property",
      source: "const loader = { require: () => undefined };\n",
    },
    {
      name: "static-import",
      source: 'import electron from "electron";\n',
    },
    {
      name: "import-type",
      source: 'import type { IpcRenderer } from "electron";\n',
    },
    {
      name: "export-from",
      source: 'export { ipcRenderer } from "electron";\n',
    },
    {
      name: "parse-error",
      source: "const PRELOAD_GATE_SOURCE_MUST_NOT_ECHO = ;\n",
    },
    {
      name: "late-strict",
      source:
        'const electron = require("electron");\n"use strict";\n',
    },
    {
      name: "template-strict",
      source:
        '`use strict`;\nconst electron = require("electron");\n',
    },
    {
      name: "concatenated-strict",
      source:
        '"use " + "strict";\nconst electron = require("electron");\n',
    },
    {
      name: "parenthesized-strict",
      source:
        '("use strict");\nconst electron = require("electron");\n',
    },
  ];

  try {
    for (const fixture of callerRecoveryFixtures) {
      expect(
        executeCommonJsFixture(fixture.source),
        `${fixture.name}-non-strict`,
      ).toEqual(fixture.runtimeRequests);

      const strictExecution = inspectCommonJsFixture(
        `"use strict";\n${fixture.source}`,
      );
      expect(
        strictExecution.requestedModules,
        `${fixture.name}-strict-requests`,
      ).toEqual([]);
      expect(
        strictExecution.error,
        `${fixture.name}-strict-error`,
      ).toMatchObject({ name: "TypeError" });
    }

    const goodDirectory = join(isolatedProject, "good");
    await mkdir(goodDirectory);
    await writeFile(
      join(goodDirectory, "index.js"),
      [
        '"use strict";',
        'const electron = require("electron");',
        'electron.contextBridge.exposeInMainWorld("zoro", Object.freeze({}));',
      ].join("\n"),
    );

    const good = await runReleaseScript(
      ["--validate-preload", goodDirectory],
      { cwd: isolatedProject },
    );
    expect(good.exitCode).toBe(0);

    for (const fixture of [
      {
        name: "single-quoted-strict",
        source:
          '\'use strict\';\nconst electron = require("electron");\n',
      },
      {
        name: "leading-trivia-strict",
        source:
          '\n/* leading comment */\n  "use strict";\nconst electron = require("electron");\n',
      },
      {
        name: "other-directive-before-strict",
        source:
          '"use client";\n\'use strict\';\nconst electron = require("electron");\n',
      },
    ]) {
      const validDirectory = join(isolatedProject, fixture.name);
      await mkdir(validDirectory);
      await writeFile(join(validDirectory, "index.js"), fixture.source);
      const valid = await runReleaseScript(
        ["--validate-preload", validDirectory],
        { cwd: isolatedProject },
      );
      expect(valid.exitCode, fixture.name).toBe(0);
    }

    const missingStrictDirectory = join(isolatedProject, "missing-strict");
    await mkdir(missingStrictDirectory);
    await writeFile(
      join(missingStrictDirectory, "index.js"),
      [
        'const electron = require("electron");',
        'electron.contextBridge.exposeInMainWorld("zoro", Object.freeze({}));',
      ].join("\n"),
    );
    const missingStrict = await runReleaseScript(
      ["--validate-preload", missingStrictDirectory],
      { cwd: isolatedProject },
    );
    expect(missingStrict.exitCode, "missing-strict").not.toBe(0);
    expect(missingStrict.stderr, "missing-strict").toContain(
      "Sandbox preload must be one self-contained bundle",
    );

    const pseudoStrictResults = [];
    for (const fixture of pseudoStrictCallerFixtures) {
      expect(
        executeCommonJsFixture(fixture.source),
        `${fixture.name}-runtime`,
      ).toEqual(fixture.runtimeRequests);

      const invalidDirectory = join(isolatedProject, fixture.name);
      await mkdir(invalidDirectory);
      await writeFile(join(invalidDirectory, "index.js"), fixture.source);
      pseudoStrictResults.push({
        fixture,
        result: await runReleaseScript(
          ["--validate-preload", invalidDirectory],
          { cwd: isolatedProject },
        ),
      });
    }
    expect(
      pseudoStrictResults.map(({ result }) => result.exitCode),
      "pseudo-strict-exit-codes",
    ).toEqual([1, 1, 1]);
    for (const { fixture, result } of pseudoStrictResults) {
      expect(result.stderr, fixture.name).toContain(
        "Sandbox preload must be one self-contained bundle",
      );
      expect(
        `${result.stdout}${result.stderr}`,
        fixture.name,
      ).not.toContain("PSEUDO_STRICT_SOURCE_MUST_NOT_ECHO");
    }

    for (const fixture of invalidFixtures) {
      if (fixture.runtimeRequests !== undefined) {
        expect(
          executeCommonJsFixture(fixture.source),
          fixture.name,
        ).toEqual(fixture.runtimeRequests);
      }
      const invalidDirectory = join(isolatedProject, fixture.name);
      await mkdir(invalidDirectory);
      const invalidPreload = join(invalidDirectory, "index.js");
      await writeFile(
        invalidPreload,
        rawGateSourceNames.has(fixture.name)
          ? fixture.source
          : `"use strict";\n${fixture.source}`,
      );
      const invalid = await runReleaseScript(
        ["--validate-preload", invalidDirectory],
        { cwd: isolatedProject },
      );
      expect(invalid.exitCode, fixture.name).not.toBe(0);
      expect(invalid.stderr, fixture.name).toContain(
        "Sandbox preload must be one self-contained bundle",
      );
      expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
        "PRELOAD_GATE_SOURCE_MUST_NOT_ECHO",
      );
      expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
        "DYNAMIC_GATE_SOURCE_MUST_NOT_ECHO",
      );
    }
  } finally {
    await rm(isolatedProject, { recursive: true, force: true });
  }
});

test("release preload gate requires one real index file in one real directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zoro-preload-layout-"));
  const goodSource =
    '"use strict";\nconst electron = require("electron");\n';

  async function createPreloadDirectory(name: string): Promise<string> {
    const directory = join(temporaryRoot, name);
    await mkdir(directory);
    await writeFile(join(directory, "index.js"), goodSource);
    return directory;
  }

  try {
    const goodDirectory = await createPreloadDirectory("good");
    const good = await runReleaseScript([
      "--validate-preload",
      goodDirectory,
    ], { cwd: temporaryRoot });
    expect(good.exitCode).toBe(0);

    const extraFile = await createPreloadDirectory("extra-file");
    await writeFile(join(extraFile, "helper.js"), goodSource);

    const extraDirectory = await createPreloadDirectory("extra-directory");
    await mkdir(join(extraDirectory, "helper"));

    const hiddenEntry = await createPreloadDirectory("hidden-entry");
    await writeFile(join(hiddenEntry, ".hidden"), goodSource);

    const fileSymlink = await createPreloadDirectory("file-symlink");
    await symlink(
      join(goodDirectory, "index.js"),
      join(fileSymlink, "helper.js"),
    );

    const directorySymlink = await createPreloadDirectory(
      "directory-symlink",
    );
    await symlink(goodDirectory, join(directorySymlink, "helper"));

    const preloadFileSymlink = join(temporaryRoot, "preload-file-symlink");
    await mkdir(preloadFileSymlink);
    await symlink(
      join(goodDirectory, "index.js"),
      join(preloadFileSymlink, "index.js"),
    );

    const preloadDirectorySymlink = join(
      temporaryRoot,
      "preload-directory-symlink",
    );
    await symlink(goodDirectory, preloadDirectorySymlink);

    for (const invalidDirectory of [
      extraFile,
      extraDirectory,
      hiddenEntry,
      fileSymlink,
      directorySymlink,
      preloadFileSymlink,
      preloadDirectorySymlink,
    ]) {
      const invalid = await runReleaseScript([
        "--validate-preload",
        invalidDirectory,
      ], { cwd: temporaryRoot });
      expect(invalid.exitCode, invalidDirectory).not.toBe(0);
      expect(invalid.stderr, invalidDirectory).toContain(
        "Sandbox preload must be one self-contained bundle",
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preload validator fails closed when TypeScript compiler is unavailable", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "zoro-preload-validator-dependency-"),
  );
  const isolatedValidator = join(temporaryRoot, "validate-preload.mjs");
  const preloadPath = join(temporaryRoot, "index.js");
  const sourceMarker = "PRELOAD_VALIDATOR_SOURCE_MUST_NOT_ECHO";

  try {
    await copyFile(
      resolve("scripts", "validate-preload.mjs"),
      isolatedValidator,
    );
    await writeFile(
      preloadPath,
      `"use strict";\nconst ${sourceMarker} = require("electron");\n`,
    );

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFile(
        process.execPath,
        [isolatedValidator, preloadPath],
        {
          cwd: temporaryRoot,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "" },
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (caught) {
      const failure = caught as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      exitCode = failure.code ?? 1;
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
    }

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "Sandbox preload must be one self-contained bundle",
    );
    expect(`${stdout}${stderr}`).not.toContain(sourceMarker);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("release failures always clean the sole full-flow temporary directory", async () => {
  const releaseScript = await readFile(resolve("scripts/create-dmg.sh"), "utf8");
  expect(releaseScript).toContain("local full_flow_status=$?");
  expect(releaseScript).not.toContain("trap cleanup EXIT");

  const isolatedProject = await mkdtemp(join(tmpdir(), "zoro-release-cleanup-"));
  const isolatedTmp = join(isolatedProject, "tmp");
  const isolatedScript = join(
    isolatedProject,
    "scripts",
    "create-dmg.sh",
  );
  try {
    await mkdir(join(isolatedProject, "scripts"), { recursive: true });
    await mkdir(join(isolatedProject, "release"), { recursive: true });
    await mkdir(isolatedTmp);
    await copyFile(resolve("scripts/create-dmg.sh"), isolatedScript);
    await writeFile(
      join(isolatedProject, "package.json"),
      JSON.stringify({
        version: "0.2.0",
        config: { release_arch: "arm64" },
      }),
    );
    await writeFile(
      join(isolatedProject, "release", "ZoroCoding-0.1.0-arm64.dmg"),
      "stale\n",
    );

    const stale = await runReleaseScript([], {
      scriptPath: isolatedScript,
      env: {
        ...process.env,
        TMPDIR: isolatedTmp,
      },
    });
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain("Stale release artifacts found");
    expect(
      (await readdir(isolatedTmp)).filter((entry) =>
        entry.startsWith("zorocoding-dmg."),
      ),
    ).toEqual([]);

    const unavailableTmp = join(isolatedProject, "cli-must-not-create-tmp");
    const cliFailure = await runReleaseScript(
      ["--validate-staging", join(isolatedProject, "missing-staging")],
      {
        scriptPath: isolatedScript,
        env: {
          ...process.env,
          TMPDIR: unavailableTmp,
        },
      },
    );
    expect(cliFailure.exitCode).not.toBe(0);
    expect(cliFailure.stderr).toContain(
      "DMG staging root must contain only ZoroCoding.app",
    );
    await expect(access(unavailableTmp)).rejects.toThrow();
  } finally {
    await rm(isolatedProject, { recursive: true, force: true });
  }
});

test("routes project tasks without changing classifier-derived safety", async () => {
  const fixture = await createE2eFixture();
  let app: ElectronApplication | null = null;

  try {
    app = await launchFixture(fixture);
    const page = await app.firstWindow();
    const appInfo = await page.evaluate(() => window.zoro.app.info());
    expect(appInfo).toMatchObject({
      portable: true,
      dataRoot: fixture.dataRoot,
      projectsRoot: fixture.projectsRoot,
      storageAvailable: true,
      restartRequired: false,
    });

    const providerSummaries = await page.evaluate(() =>
      window.zoro.providers.list(),
    );
    const serializedProviders = JSON.stringify(providerSummaries);
    expect(providerSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "e2e-groq",
          name: "Groq",
          modelId: "zoro-e2e-light",
        }),
        expect.objectContaining({
          id: "e2e-kimi-k3",
          name: "KIMI K3",
          modelId: "zoro-e2e-premium",
        }),
      ]),
    );
    expect(serializedProviders).not.toContain("secretRef");
    expect(serializedProviders).not.toContain("apiKey");
    expect(serializedProviders).not.toContain(E2E_PROVIDER_API_KEY);
    await expect
      .poll(() => page.evaluate(() => window.zoro.routing.get()))
      .toMatchObject({
        lightProviderId: "e2e-groq",
        premiumProviderId: "e2e-kimi-k3",
      });

    const simplePrompt =
      "请解释这段 TypeScript 代码 [mock:read-only-forge]";
    await startTask(page, simplePrompt, { authorizeProject: true });
    await expect(page.getByText("执行方式：只读问答")).toBeVisible();
    await expect(page.getByText("实际模型：Groq · zoro-e2e-light")).toBeVisible();
    await expect(page.getByText("任务已完成", { exact: false })).toBeVisible();
    expect(await readFile(join(fixture.fixtureProject, "version.txt"), "utf8"))
      .toBe("1\n");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const simpleDetail = await page.evaluate(async (prompt) => {
      const task = (await window.zoro.tasks.list()).find(
        (candidate) => candidate.prompt === prompt,
      );
      if (task === undefined) {
        throw new Error("Missing simple E2E task");
      }
      return window.zoro.tasks.get(task.id);
    }, simplePrompt);
    expect(
      simpleDetail.events
        .filter((event) => event.type === "tool_completed")
        .map((event) =>
          event.type === "tool_completed"
            ? {
                name: event.payload.name,
                ok: event.payload.ok,
                denied: event.payload.denied,
              }
            : null,
        ),
    ).toEqual([
      { name: "write_file", ok: false, denied: true },
      { name: "run_shell", ok: false, denied: true },
    ]);
    expect(
      simpleDetail.events.filter((event) => event.type === "tool_output"),
    ).toEqual([]);
    await expect(
      page
        .getByLabel("任务执行记录")
        .locator(".activity-details")
        .filter({ hasText: "终端输出" }),
    ).toHaveCount(0);

    const simpleRequests = fixture.model.requests.filter((request) =>
      request.userPromptDigests.includes(promptDigest(simplePrompt)),
    );
    expect(simpleRequests.length).toBeGreaterThan(1);
    expect(simpleRequests.every((request) => request.model === "zoro-e2e-light"))
      .toBe(true);
    expect(
      simpleRequests
        .filter((request) => request.toolNames.length > 0)
        .every((request) =>
          request.toolNames.every((name) =>
            ["list_files", "read_file", "search_files"].includes(name),
          ),
        ),
    ).toBe(true);
    expect(simpleRequests.at(-1)?.toolResponses).toEqual([
      { callId: "write-version", denied: true },
      { callId: "verify-version", denied: true },
    ]);

    const complexPrompt = "修改 version.txt 并运行测试";
    await startTask(page, complexPrompt);
    await expect(page.getByText("执行方式：完整执行")).toBeVisible();
    await expect(
      page.getByText("实际模型：KIMI K3 · zoro-e2e-premium"),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "任务完成进度" }),
    ).toBeVisible();
    await expect(page.getByText("预计剩余", { exact: true })).toBeVisible();
    const approval = page.getByRole("alertdialog");
    await expect(approval).toBeVisible();
    await approval.getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByText("任务已完成", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "任务完成进度" }),
    ).toHaveAttribute("aria-valuenow", "100");
    await expect(
      page
        .getByLabel("任务执行记录")
        .getByText("终端输出", { exact: true }),
    ).toBeVisible();
    expect(await readFile(join(fixture.fixtureProject, "version.txt"), "utf8"))
      .toBe("2\n");

    const complexRequests = fixture.model.requests.filter((request) =>
      request.userPromptDigests.includes(promptDigest(complexPrompt)),
    );
    expect(complexRequests.length).toBeGreaterThan(1);
    expect(
      complexRequests.every(
        (request) => request.model === "zoro-e2e-premium",
      ),
    ).toBe(true);

    const manualPrompt = "请解释这段 TypeScript 代码（手动模型）";
    await startTask(page, manualPrompt, {
      manualProvider: "KIMI K3 · zoro-e2e-premium",
    });
    await expect(page.getByText("选择方式：手动")).toBeVisible();
    await expect(page.getByText("执行方式：只读问答")).toBeVisible();
    await expect(
      page.getByText("实际模型：KIMI K3 · zoro-e2e-premium"),
    ).toBeVisible();
    await expect(page.getByText("任务已完成", { exact: false })).toBeVisible();
    expect(await readFile(join(fixture.fixtureProject, "version.txt"), "utf8"))
      .toBe("2\n");
    const manualRequests = fixture.model.requests.filter((request) =>
      request.userPromptDigests.includes(promptDigest(manualPrompt)),
    );
    expect(manualRequests.length).toBeGreaterThan(1);
    expect(
      manualRequests.every(
        (request) =>
          request.providerId === "e2e-kimi-k3" &&
          request.model === "zoro-e2e-premium",
      ),
    ).toBe(true);

    const failedPrompt =
      "请解释这段 TypeScript 代码 [mock:fail-always]";
    await startTask(page, failedPrompt);
    await expect(page.getByText("任务执行失败", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect(await approvedColorViolations(page)).toEqual([]);
    const failedRequests = fixture.model.requests.filter((request) =>
      request.userPromptDigests.includes(promptDigest(failedPrompt)),
    );
    expect(failedRequests.length).toBeGreaterThan(1);
    expect(failedRequests.every((request) => request.model === "zoro-e2e-light"))
      .toBe(true);

    await page.getByRole("button", { name: "设置与模型" }).click();
    await expect(page.getByText("自动模型路由", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "轻量模型" }).click();
    await page
      .getByRole("option", { name: "KIMI K3 · zoro-e2e-premium" })
      .click();
    await page.getByRole("combobox", { name: "高级模型" }).click();
    await page
      .getByRole("option", { name: "Groq · zoro-e2e-light" })
      .click();
    await page.getByRole("button", { name: "保存自动模型路由" }).click();
    await expect
      .poll(() => page.evaluate(() => window.zoro.routing.get()))
      .toMatchObject({
        lightProviderId: "e2e-kimi-k3",
        premiumProviderId: "e2e-groq",
      });

    await expect(access(join(fixture.appDataRoot, "zorocoding.sqlite"))).resolves
      .toBeUndefined();
    await closeE2eApp(app);
    app = null;

    app = await launchFixture(fixture);
    const pageAfterRestart = await app.firstWindow();
    await expect
      .poll(() => pageAfterRestart.evaluate(() => window.zoro.routing.get()))
      .toMatchObject({
        lightProviderId: "e2e-kimi-k3",
        premiumProviderId: "e2e-groq",
      });
    await pageAfterRestart
      .getByRole("button", { name: complexPrompt })
      .click();
    await expect(pageAfterRestart.getByText("选择方式：自动")).toBeVisible();
    await expect(
      pageAfterRestart.getByText(
        "实际模型：KIMI K3 · zoro-e2e-premium",
      ),
    ).toBeVisible();
    await expect(pageAfterRestart.getByText("执行方式：完整执行")).toBeVisible();
    const persistedComplexTask = await pageAfterRestart.evaluate(
      async (prompt) => {
        const task = (await window.zoro.tasks.list()).find(
          (candidate) => candidate.prompt === prompt,
        );
        if (task === undefined) {
          throw new Error("Missing persisted complex E2E task");
        }
        return window.zoro.tasks.get(task.id);
      },
      complexPrompt,
    );
    expect(persistedComplexTask.task).toMatchObject({
      selectionMode: "auto",
      executionMode: "agentic",
      providerSnapshot: {
        providerId: "e2e-kimi-k3",
        name: "KIMI K3",
        modelId: "zoro-e2e-premium",
      },
    });

    for (const defaultDirectoryName of ["zorocoding", "ZoroCoding"]) {
      await expect(
        access(
          join(
            fixture.isolatedHome,
            "Library",
            "Application Support",
            defaultDirectoryName,
          ),
        ),
      ).rejects.toThrow();
    }
  } finally {
    await disposeE2eFixture(fixture, app);
  }
});

test("keeps zero-project Quick Chat tool-free, persistent, and recoverable", async () => {
  const fixture = await createE2eFixture();
  let app: ElectronApplication | null = null;
  const unavailableProjectsRoot = `${fixture.projectsRoot}-offline`;

  try {
    app = await launchFixture(fixture);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "快速问答" }).click();
    await expect(page.getByRole("heading", { name: "快速问答" })).toBeVisible();
    await expect(page.getByText("无项目对话", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择项目" })).toHaveCount(0);
    await expect(page.getByText("终端输出", { exact: true })).toHaveCount(0);
    await expect(page.getByText("当前项目边界", { exact: true })).toHaveCount(0);

    const simplePrompt = "为什么天空是蓝色";
    await page.getByLabel("快速问答内容").fill(simplePrompt);
    await expect(
      page.getByText("实际模型：Groq · zoro-e2e-light"),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("轻量问答已完成。", { exact: true })).toBeVisible();

    const complexPrompt = "设计一个复杂的 TypeScript 架构方案";
    await page.getByLabel("快速问答内容").fill(complexPrompt);
    await expect(
      page.getByText("实际模型：KIMI K3 · zoro-e2e-premium"),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("高级问答已完成。", { exact: true })).toBeVisible();

    const mediaPrompt = "用 Remotion 制作产品演示视频";
    await page.getByLabel("快速问答内容").fill(mediaPrompt);
    await expect(
      page.getByText("此处只能生成方案或代码，不能直接创建本地文件。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "转为项目任务" }).click();
    const conversionDialog = page.getByRole("dialog", { name: "发起新任务" });
    await expect(conversionDialog.getByLabel("任务要求")).toHaveValue(
      mediaPrompt,
    );
    await expect(
      conversionDialog.getByRole("button", { name: "选择项目" }),
    ).toContainText("通过 macOS 文件夹选择器授权");
    await conversionDialog.getByRole("button", { name: "关闭" }).click();

    const retryPrompt = "为什么会失败 [mock:fail-once]";
    await page.getByLabel("快速问答内容").fill(retryPrompt);
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByRole("button", { name: "重试这条回复" }))
      .toBeVisible();
    await page.getByRole("button", { name: "重试这条回复" }).click();
    await expect(page.getByText("轻量问答已完成。", { exact: true }).last())
      .toBeVisible();

    const delayedPrompt = "为什么会延迟 [mock:delay]";
    await page.getByLabel("快速问答内容").fill(delayedPrompt);
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "取消回答" }).click();
    await expect(page.getByText("回答已取消。", { exact: true })).toBeVisible();

    const chatRequests = fixture.model.requests.filter(
      (request) => request.quickChat,
    );
    expect(chatRequests.length).toBeGreaterThan(2);
    expect(chatRequests.every((request) => request.toolNames.length === 0))
      .toBe(true);

    await closeE2eApp(app);
    app = null;
    app = await launchFixture(fixture);
    const persistedPage = await app.firstWindow();
    await persistedPage.getByRole("button", { name: "快速问答" }).click();
    await expect(
      persistedPage
        .locator(".quick-chat-feed")
        .getByText(simplePrompt, { exact: true }),
    ).toBeVisible();
    const persistedFeed = persistedPage.locator(".quick-chat-feed");
    const restoredSimpleReply = persistedFeed
      .locator(".quick-chat-assistant-message")
      .filter({ hasText: "轻量问答已完成。" })
      .first();
    await expect(restoredSimpleReply).toContainText(
      "实际模型：Groq · zoro-e2e-light",
    );
    const restoredComplexReply = persistedFeed
      .locator(".quick-chat-assistant-message")
      .filter({ hasText: "高级问答已完成。" });
    await expect(restoredComplexReply).toContainText(
      "实际模型：KIMI K3 · zoro-e2e-premium",
    );
    const persistedMessages = await persistedPage.evaluate(
      async (simple) => {
        for (const session of await window.zoro.quickChat.listSessions()) {
          const messages = await window.zoro.quickChat.listMessages(session.id);
          if (
            messages.some(
              (message) =>
                message.role === "user" && message.content === simple,
            )
          ) {
            return messages;
          }
        }
        throw new Error("Missing persisted Quick Chat session");
      },
      simplePrompt,
    );
    expect(persistedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "轻量问答已完成。",
          status: "completed",
          providerSnapshot: expect.objectContaining({
            providerId: "e2e-groq",
            modelId: "zoro-e2e-light",
          }),
          routeDecision: expect.objectContaining({ lane: "light" }),
        }),
        expect.objectContaining({
          role: "assistant",
          content: "高级问答已完成。",
          status: "completed",
          providerSnapshot: expect.objectContaining({
            providerId: "e2e-kimi-k3",
            modelId: "zoro-e2e-premium",
          }),
          routeDecision: expect.objectContaining({ lane: "premium" }),
        }),
      ]),
    );
    await expect(
      persistedPage
        .locator(".quick-chat-feed")
        .getByText(complexPrompt, { exact: true }),
    ).toBeVisible();

    await rename(fixture.projectsRoot, unavailableProjectsRoot);
    await expect(
      persistedPage.getByRole("alertdialog", { name: "移动硬盘已断开" }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      persistedPage.getByRole("button", { name: "发起新任务" }),
    ).toBeDisabled();
    await rename(unavailableProjectsRoot, fixture.projectsRoot);
    await expect(
      persistedPage.getByRole("alertdialog", { name: "移动硬盘已断开" }),
    ).toBeVisible();
  } finally {
    await rename(unavailableProjectsRoot, fixture.projectsRoot).catch(() => {});
    await disposeE2eFixture(fixture, app);
  }
});

test("missing automatic role fails closed in project and Quick Chat UI", async () => {
  const fixture = await createE2eFixture();
  let app: ElectronApplication | null = null;

  try {
    app = await launchFixture(fixture, {
      ZORO_E2E_SKIP_LIGHT_PROVIDER: "1",
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "快速问答" }).click();
    await page.getByLabel("快速问答内容").fill("为什么天空是蓝色");
    await expect(page.getByText("轻量模型未配置", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "前往设置" })).toBeVisible();

    await page.getByRole("button", { name: "发起新任务" }).click();
    await authorizeFixtureProject(page);
    await page.getByLabel("任务要求").fill("请解释这段 TypeScript 代码");
    const newTaskDialog = page.getByRole("dialog", { name: "发起新任务" });
    await expect(
      newTaskDialog.getByText("轻量模型未配置", { exact: true }),
    ).toBeVisible();
    await expect(
      newTaskDialog.getByRole("button", { name: "开始任务" }),
    ).toBeDisabled();
  } finally {
    await disposeE2eFixture(fixture, app);
  }
});

test("computed desktop surfaces use only the approved black-green palette", async ({
}, testInfo) => {
  const fixture = await createE2eFixture();
  let app: ElectronApplication | null = null;

  try {
    app = await launchFixture(fixture, {
      ZORO_E2E_STARTUP_DELAY_MS: "1500",
    });
    const page = await app.firstWindow();
    const loading = page.locator(".app-loading");
    await expect(loading).toBeVisible();
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("loading-black-green.png"),
      fullPage: true,
    });
    await expect(page.locator(".app-frame")).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(page.getByText("ZoroCoding", { exact: true }).first())
      .toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.style.colorScheme ||
          getComputedStyle(document.documentElement).colorScheme,
      ),
    ).toContain("dark");
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("workbench-black-green.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "快速问答" }).click();
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("quick-chat-black-green.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "设置与模型" }).click();
    await expect(page.getByText("自动模型路由", { exact: true })).toBeVisible();
    expect(await approvedColorViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "发起新任务" }).click();
    await authorizeFixtureProject(page);
    await page.getByLabel("任务要求").fill("修改 version.txt 并运行测试");
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "开始任务" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("approval-progress-black-green.png"),
      fullPage: true,
    });
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "允许一次" })
      .click();
    await expect(page.getByText("任务已完成", { exact: false })).toBeVisible();
    await page.getByText("已修改文件", { exact: true }).click();
    await page
      .getByLabel("任务执行记录")
      .getByText("终端输出", { exact: true })
      .click();
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("results-black-green.png"),
      fullPage: true,
    });
  } finally {
    await disposeE2eFixture(fixture, app);
  }
});


test("integration settings persist opt-in without sending data and preserve model tasks", async ({}, testInfo) => {
  const fixture = await createE2eFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launchFixture(fixture);
    let page = await app.firstWindow();
    await expect(page.locator(".app-frame")).toBeVisible();
    // Authorize an isolated fixture project, then reload the stored project list.
    await page.evaluate(() => window.zoro.projects.select());
    await closeE2eApp(app);
    app = await launchFixture(fixture);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "设置与模型" }).click();
    const memory = page.getByRole("region", { name: "外部记忆" });
    const review = page.getByRole("region", { name: "操作审查" });
    await expect(memory.getByLabel("启用外部记忆")).not.toBeChecked();
    await expect(memory.getByLabel("fixture", { exact: true })).not.toBeChecked();
    await memory.getByLabel("服务地址").fill(fixture.model.baseUrl);
    await memory.getByLabel("令牌", { exact: true }).fill("private-integration-token");
    await memory.getByLabel("启用外部记忆").check();
    await memory.getByLabel("允许读取记忆").check();
    await memory.getByLabel("fixture", { exact: true }).check();
    await memory.getByRole("button", { name: "保存集成设置" }).click();
    await expect(memory.getByRole("status")).toContainText("已保存");
    await expect(memory.getByLabel("令牌", { exact: true })).toHaveValue("");
    await review.getByRole("combobox", { name: "审查方式", exact: true }).click();
    await page.getByRole("option", { name: "HTTP 审查服务" }).click();
    await review.getByRole("combobox", { name: "审查服务不可用时" }).click();
    await page.getByRole("option", { name: "请求手动确认" }).click();
    await review.getByRole("button", { name: "保存集成设置" }).click();
    await expect(review.getByRole("status")).toContainText("已保存");
    await memory.scrollIntoViewIfNeeded();
    expect(await approvedColorViolations(page)).toEqual([]);
    await memory.screenshot({ path: testInfo.outputPath("memory-settings.png") });
    await review.screenshot({ path: testInfo.outputPath("review-settings.png") });
    await memory.getByRole("button", { name: "查看将发送的内容" }).click();
    const preview = page.getByRole("dialog");
    await expect(preview).toContainText("当前不会发送数据");
    await expect(preview).not.toContainText("private-integration-token");
    await expect(preview).not.toContainText(fixture.fixtureProject);
    expect(await approvedColorViolations(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("integration-preview.png") });
    await preview.getByRole("button", { name: "关闭预览" }).click();
    expect(fixture.model.requestPaths).toEqual([]);

    await closeE2eApp(app);
    app = await launchFixture(fixture);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "设置与模型" }).click();
    const restored = page.getByRole("region", { name: "外部记忆" });
    await expect(restored.getByLabel("启用外部记忆")).toBeChecked();
    await expect(restored.getByLabel("允许读取记忆")).toBeChecked();
    await expect(restored.getByLabel("允许写入记忆")).not.toBeChecked();
    await expect(restored.getByLabel("fixture", { exact: true })).toBeChecked();
    await expect(restored.getByLabel("令牌", { exact: true })).toHaveValue("");
    await expect(restored.getByRole("button", { name: "测试连接（暂不可用）" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "操作审查" }).getByRole("combobox", { name: "审查方式", exact: true })).toContainText("HTTP 审查服务");
    await expect(page.getByRole("region", { name: "操作审查" }).getByRole("combobox", { name: "审查服务不可用时" })).toContainText("请求手动确认");
    expect(await page.locator("body").innerHTML()).not.toContain("private-integration-token");
    expect(fixture.model.requestPaths).toEqual([]);
    await startTask(page, "修改 version.txt 并运行测试");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByText("任务已完成", { exact: false })).toBeVisible();
    expect(await readFile(join(fixture.fixtureProject, "version.txt"), "utf8")).toBe("2\n");
    expect(fixture.model.requests.length).toBeGreaterThan(0);
    expect(fixture.model.requestPaths.every((path) => path === "/v1/chat/completions")).toBe(true);
  } finally {
    await disposeE2eFixture(fixture, app);
  }
});
