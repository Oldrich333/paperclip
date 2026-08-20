import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("claude-local remote permission args", () => {
  it("uses the canonical Bash tool grant for remote execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("uses the canonical Bash tool grant for remote probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("does not use Bash(*) because Claude Code treats Bash grants as command-prefix patterns", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
    });

    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("grants an attached gateway's tools so permission matches availability", () => {
    const [flag, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      mcpServerNames: ["support_intake"],
    });
    const entries = allowedTools.split(" ");

    expect(flag).toBe("--allowedTools");
    // Both spellings: they are the same grant, but different Claude Code
    // releases match on different ones and the CLI version is not pinned.
    expect(entries).toContain("mcp__support_intake");
    expect(entries).toContain("mcp__support_intake__*");
    // The built-ins are still granted alongside.
    expect(entries).toContain("Read");
  });

  it("grants every attached gateway, deduplicated and order-independent", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      mcpServerNames: ["machine_reads", "cloudflare", "machine_reads"],
    });
    const entries = allowedTools.split(" ");

    expect(entries).toContain("mcp__cloudflare");
    expect(entries).toContain("mcp__machine_reads");
    expect(entries.filter((entry) => entry === "mcp__machine_reads")).toHaveLength(1);
  });

  it("drops a server name containing whitespace instead of corrupting the allowlist", () => {
    // `--allowedTools` is space-separated, so an unusable name must not be
    // emitted: it would split into fragments and widen the entries around it.
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      mcpServerNames: ["bad name", "good_name"],
    });
    const entries = allowedTools.split(" ");

    expect(entries).toContain("mcp__good_name");
    expect(entries.some((entry) => entry.includes("bad"))).toBe(false);
    expect(entries.some((entry) => entry === "name")).toBe(false);
  });

  it("grants gateway tools on remote probes too", () => {
    const [, allowedTools] = buildClaudeProbePermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      mcpServerNames: ["support_intake"],
    });

    expect(allowedTools.split(" ")).toContain("mcp__support_intake");
  });

  it("emits no mcp grants when no gateway is attached", () => {
    expect(
      buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for local execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("uses dangerously-skip-permissions for local probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });
});
