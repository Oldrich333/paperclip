// AX: ADAPTER | SUM: write Cursor user mcp.json for hive-workspace-foundation stdio | SIG: cursor_foundation_mcp_v1
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACE_FOUNDATION_MCP_NAME,
  resolveWorkspaceFoundationMcpStdio,
  type WorkspaceFoundationMcpStdio,
} from "@paperclipai/adapter-utils/workspace-foundation-mcp";

type CursorMcpFile = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Inject foundation MCP into the Cursor user config (`$HOME/.cursor/mcp.json`).
 * Prefer user config over the project workspace so Local runs do not mutate a
 * shared project checkout.
 */
export async function writeCursorWorkspaceFoundationMcp(input: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<{ configPath: string; foundation: WorkspaceFoundationMcpStdio } | null> {
  const foundation = resolveWorkspaceFoundationMcpStdio(input.env ?? process.env);
  if (!foundation) return null;

  const home = input.homeDir?.trim() || os.homedir();
  const cursorDir = path.join(home, ".cursor");
  const configPath = path.join(cursorDir, "mcp.json");
  await fs.mkdir(cursorDir, { recursive: true });

  let existing: CursorMcpFile = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as CursorMcpFile;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const mcpServers = {
    ...(existing.mcpServers && typeof existing.mcpServers === "object"
      ? existing.mcpServers
      : {}),
    [WORKSPACE_FOUNDATION_MCP_NAME]: {
      command: foundation.command,
      args: foundation.args,
    },
  };

  const next: CursorMcpFile = {
    ...existing,
    mcpServers,
  };
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return { configPath, foundation };
}
