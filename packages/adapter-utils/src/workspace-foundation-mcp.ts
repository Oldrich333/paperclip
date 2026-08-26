// AX: ADAPTER | SUM: resolve bundled hive-workspace-foundation stdio MCP for Local adapters | SIG: ws_foundation_mcp_v1
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_FOUNDATION_MCP_NAME = "hive-workspace-foundation";

/** Env keys the stdio child must receive; Cursor/Codex do not inherit the agent process env. */
const WORKSPACE_FOUNDATION_MCP_ENV_KEYS = [
  "PAPERCLIP_WORKSPACE_CWD",
  "HIVE_WORKSPACE_ROOT",
  "HIVE_WORKSPACE_EXTRA_ROOTS",
] as const;

export type WorkspaceFoundationMcpStdio = {
  name: typeof WORKSPACE_FOUNDATION_MCP_NAME;
  command: string;
  args: string[];
  scriptPath: string;
  /** Literal env for the MCP child (cwd/root); empty when unavailable at resolve time. */
  env: Record<string, string>;
};

function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pick workspace-root env the foundation MCP child needs when spawned without agent env. */
export function workspaceFoundationMcpChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of WORKSPACE_FOUNDATION_MCP_ENV_KEYS) {
    const value = nonEmpty(env[key]);
    if (value) out[key] = value;
  }
  return out;
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
      env: workspaceFoundationMcpChildEnv(env),
    };
  }
  return null;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Upsert stdio `hive-workspace-foundation` (+ `.env`) into a managed Codex
 * `config.toml`. Used by ACPX Codex home prep: classic `codex_local` CLI
 * execute already writes this via `writeManagedCodexMcpConfig`, but the default
 * ACP engine never reaches that path.
 */
export async function ensureCodexHomeWorkspaceFoundation(input: {
  codexHome: string;
  foundation: WorkspaceFoundationMcpStdio;
}): Promise<{ configPath: string; wrote: boolean }> {
  const configPath = path.join(input.codexHome, "config.toml");
  await fsPromises.mkdir(input.codexHome, { recursive: true });
  let existing = "";
  try {
    existing = await fsPromises.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const name = input.foundation.name;
  const header = `[mcp_servers.${tomlString(name)}]`;
  const envHeader = `[mcp_servers.${tomlString(name)}.env]`;
  const lines = [
    header,
    `command = ${tomlString(input.foundation.command)}`,
    `args = [${input.foundation.args.map((arg) => tomlString(arg)).join(", ")}]`,
  ];
  const envEntries = Object.entries(input.foundation.env).filter(
    ([, value]) => value.trim().length > 0,
  );
  if (envEntries.length > 0) {
    lines.push(envHeader);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  const block = `${lines.join("\n")}\n`;

  // Strip prior foundation server + optional .env table (quoted or bare name).
  const stripRe = new RegExp(
    String.raw`(?:^|\n)\[mcp_servers\.(?:"${name}"|'${name}'|${name})(?:\.env)?\][\s\S]*?(?=\n\[|\n*$)`,
    "g",
  );
  const stripped = existing.replace(stripRe, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const next = stripped.length > 0 ? `${stripped}\n\n${block}` : block;
  if (next === existing) return { configPath, wrote: false };
  await fsPromises.writeFile(configPath, next.endsWith("\n") ? next : `${next}\n`, {
    mode: 0o600,
  });
  return { configPath, wrote: true };
}
