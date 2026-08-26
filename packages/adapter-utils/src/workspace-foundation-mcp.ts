// AX: ADAPTER | SUM: resolve bundled hive-workspace-foundation stdio MCP for Local adapters | SIG: ws_foundation_mcp_v1
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_FOUNDATION_MCP_NAME = "hive-workspace-foundation";

export type WorkspaceFoundationMcpStdio = {
  name: typeof WORKSPACE_FOUNDATION_MCP_NAME;
  command: string;
  args: string[];
  scriptPath: string;
};

function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isExecutableScript(candidate: string): boolean {
  try {
    const st = fs.statSync(candidate);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function bundledAssetPath(): string {
  // dist/workspace-foundation-mcp.js -> ../assets/...
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../assets/hive_workspace_foundation_mcp.py",
  );
}

/**
 * Resolve the read-only hive-workspace-foundation stdio MCP for Paperclip Local runs.
 * Preference: explicit env override → image-bundled asset → managed workspace copy.
 * Never requires host /opt/hive* mounts.
 */
export function resolveWorkspaceFoundationMcpStdio(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFoundationMcpStdio | null {
  const candidates: string[] = [];
  const override = nonEmpty(env.HIVE_WORKSPACE_FOUNDATION_MCP);
  if (override) candidates.push(path.resolve(override));
  candidates.push(bundledAssetPath());
  const workspaceCwd = nonEmpty(env.PAPERCLIP_WORKSPACE_CWD);
  if (workspaceCwd) {
    candidates.push(
      path.resolve(workspaceCwd, "deploy/agent-runtime/hive_workspace_foundation_mcp.py"),
    );
  }
  const appRoot = nonEmpty(env.PAPERCLIP_APP_ROOT) ?? "/app";
  candidates.push(path.resolve(appRoot, "agent-runtime/hive_workspace_foundation_mcp.py"));
  candidates.push(
    path.resolve(appRoot, "packages/adapter-utils/assets/hive_workspace_foundation_mcp.py"),
  );

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isExecutableScript(candidate)) continue;
    const command = nonEmpty(env.HIVE_WORKSPACE_FOUNDATION_PYTHON) ?? "python3";
    return {
      name: WORKSPACE_FOUNDATION_MCP_NAME,
      command,
      args: [candidate],
      scriptPath: candidate,
    };
  }
  return null;
}
