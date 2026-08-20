import { buildMcpToolGrants } from "@paperclipai/adapter-utils/mcp-tool-grants";

// Explicit allowlist of Claude Code tools we permit when running on a remote
// target. We use this instead of `--dangerously-skip-permissions` for remote
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive run, but blanket-allowing every tool would
// defeat the point of having a separate hosted/sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in remote runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside remote targets, which can look like the tool is
// "broken" rather than intentionally gated.
//
// This constant covers Claude Code's *built-in* tools only. Tools delivered by
// Paperclip's runtime MCP gateways are granted separately — see
// `buildMcpToolGrants` below.
const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

// Built-in tools are only half the grant: the tools delivered by Paperclip's
// runtime MCP gateways have to be permitted too, or the client refuses them
// before any Paperclip check runs. `buildMcpToolGrants` carries the runtime's
// availability decision into permission — see that module for why this grants
// no new authority.
function buildRemoteAllowedTools(mcpServerNames: readonly string[] | undefined): string {
  return [SANDBOX_ALLOWED_TOOLS, ...buildMcpToolGrants(mcpServerNames)].join(" ");
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  mcpServerNames?: readonly string[];
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For remote targets, mirror the execution path: pass `--allowedTools`
  // with the curated allowlist instead of dropping the flag entirely. The
  // hello probe is a one-shot prompt that should never trigger a tool, but
  // if a future probe prompt does, we don't want Claude CLI to stall on an
  // interactive permission prompt that no human can answer.
  if (input.targetIsRemote) return ["--allowedTools", buildRemoteAllowedTools(input.mcpServerNames)];
  return ["--dangerously-skip-permissions"];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  mcpServerNames?: readonly string[];
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (input.targetIsRemote) {
    return ["--allowedTools", buildRemoteAllowedTools(input.mcpServerNames)];
  }
  return ["--dangerously-skip-permissions"];
}
