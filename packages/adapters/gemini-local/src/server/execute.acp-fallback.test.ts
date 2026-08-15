import { beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeGeminiAcp,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeGeminiAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "gemini"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "init", session_id: "gemini-session-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createGeminiAcpExecutor: () => executeGeminiAcp,
  formatGeminiAcpFallbackMessage: (reason: string) =>
    `[paperclip] Gemini ACP default unavailable; falling back to Gemini CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveGeminiExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
        ? { engine: "acp", explicit: true }
        : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gemini Coder",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      env: { GEMINI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("gemini_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to Gemini CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello");
    expect(executeGeminiAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Gemini ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("fails closed before remote staging when the deployment rulebook is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-rulebook-"));
    const sourcePath = path.join(root, "agent_rulebook.md");
    await writeFile(sourcePath, "canonical HIVE instructions\n", "utf8");
    const previousSource = process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
    process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = sourcePath;
    try {
      await expect(execute({
        ...buildContext({ engine: "cli", cwd: root }),
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote/workspace" },
      } as never)).rejects.toThrow("Gemini remote execution is refused");
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    } finally {
      if (previousSource === undefined) delete process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
      else process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = previousSource;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Gemini's native global GEMINI.md context for the CLI lane", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-system-"));
    const sourcePath = path.join(root, "agent_rulebook.md");
    const cwd = path.join(root, "workspace");
    await writeFile(sourcePath, "canonical HIVE instructions\n", "utf8");
    await mkdir(cwd, { recursive: true });
    const previousHome = process.env.HOME;
    const previousSource = process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
    process.env.HOME = root;
    process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = sourcePath;
    const commandNotes: string[] = [];
    try {
      const ctx = {
        ...buildContext({ engine: "cli", cwd, env: { GEMINI_API_KEY: "test-key", GEMINI_CLI_HOME: root } }),
        onMeta: async (meta: { commandNotes?: string[] }) => commandNotes.push(...(meta.commandNotes ?? [])),
      };
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(commandNotes.join("\n")).toContain("isolated per-run Gemini global GEMINI.md");
      await expect(access(path.join(root, ".gemini", "GEMINI.md"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousSource === undefined) delete process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
      else process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = previousSource;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite occupied Gemini context files or fall back to a user prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-system-collision-"));
    const sourcePath = path.join(root, "agent_rulebook.md");
    const cwd = path.join(root, "workspace");
    const globalPath = path.join(root, ".gemini", "GEMINI.md");
    const projectPath = path.join(cwd, "GEMINI.md");
    await mkdir(path.dirname(globalPath), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(sourcePath, "canonical HIVE instructions\n", "utf8");
    await writeFile(globalPath, "existing global instructions\n", "utf8");
    await writeFile(projectPath, "existing project instructions\n", "utf8");
    const previousHome = process.env.HOME;
    const previousSource = process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
    process.env.HOME = root;
    process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = sourcePath;
    const metadata: Array<{ commandNotes?: string[]; prompt?: string }> = [];
    try {
      const ctx = {
        ...buildContext({ engine: "cli", cwd, env: { GEMINI_API_KEY: "test-key", GEMINI_CLI_HOME: root } }),
        onMeta: async (meta: { commandNotes?: string[]; prompt?: string }) => {
          metadata.push(meta);
        },
      };
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(await readFile(globalPath, "utf8")).toBe("existing global instructions\n");
      expect(await readFile(projectPath, "utf8")).toBe("existing project instructions\n");
      expect(metadata[0]?.prompt).not.toContain("canonical HIVE instructions");
      expect(metadata[0]?.commandNotes?.join("\n")).toContain("isolated per-run Gemini global GEMINI.md");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousSource === undefined) delete process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE;
      else process.env.PAPERCLIP_SYSTEM_INSTRUCTIONS_FILE = previousSource;
      await rm(root, { recursive: true, force: true });
    }
  });
});
