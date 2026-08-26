import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FOUNDATION_MCP_NAME,
  ensureCodexHomeWorkspaceFoundation,
  resolveWorkspaceFoundationMcpStdio,
  workspaceFoundationMcpChildEnv,
} from "./workspace-foundation-mcp.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-foundation-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveWorkspaceFoundationMcpStdio", () => {
  it("prefers HIVE_WORKSPACE_FOUNDATION_MCP when the file exists", () => {
    const root = tempDir();
    const script = path.join(root, "foundation.py");
    fs.writeFileSync(script, "print('ok')\n");
    const resolved = resolveWorkspaceFoundationMcpStdio({
      HIVE_WORKSPACE_FOUNDATION_MCP: script,
      PAPERCLIP_WORKSPACE_CWD: "/workspace/run",
    });
    expect(resolved).toEqual({
      name: WORKSPACE_FOUNDATION_MCP_NAME,
      command: "python3",
      args: [script],
      scriptPath: script,
      env: { PAPERCLIP_WORKSPACE_CWD: "/workspace/run" },
    });
  });

  it("honors HIVE_WORKSPACE_FOUNDATION_PYTHON for the command", () => {
    const root = tempDir();
    const script = path.join(root, "foundation.py");
    fs.writeFileSync(script, "print('ok')\n");
    const resolved = resolveWorkspaceFoundationMcpStdio({
      HIVE_WORKSPACE_FOUNDATION_MCP: script,
      HIVE_WORKSPACE_FOUNDATION_PYTHON: "/usr/bin/python3",
    });
    expect(resolved?.command).toBe("/usr/bin/python3");
  });

  it("resolves the package-bundled asset when no override is set", () => {
    const resolved = resolveWorkspaceFoundationMcpStdio({
      PAPERCLIP_WORKSPACE_CWD: "/nonexistent-workspace",
      PAPERCLIP_APP_ROOT: "/nonexistent-app",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe(WORKSPACE_FOUNDATION_MCP_NAME);
    expect(resolved!.command).toBe("python3");
    expect(resolved!.scriptPath.endsWith("hive_workspace_foundation_mcp.py")).toBe(true);
    expect(fs.existsSync(resolved!.scriptPath)).toBe(true);
    expect(resolved!.env).toEqual({ PAPERCLIP_WORKSPACE_CWD: "/nonexistent-workspace" });
  });
});

describe("workspaceFoundationMcpChildEnv", () => {
  it("keeps only non-empty workspace root keys", () => {
    expect(
      workspaceFoundationMcpChildEnv({
        PAPERCLIP_WORKSPACE_CWD: " /ws ",
        HIVE_WORKSPACE_ROOT: "",
        HIVE_WORKSPACE_EXTRA_ROOTS: "/opt/hive20",
        UNRELATED: "x",
      }),
    ).toEqual({
      PAPERCLIP_WORKSPACE_CWD: "/ws",
      HIVE_WORKSPACE_EXTRA_ROOTS: "/opt/hive20",
    });
  });
});

describe("ensureCodexHomeWorkspaceFoundation", () => {
  it("writes stdio foundation + env into config.toml", async () => {
    const home = tempDir();
    const script = path.join(home, "foundation.py");
    fs.writeFileSync(script, "print('ok')\n");
    const result = await ensureCodexHomeWorkspaceFoundation({
      codexHome: home,
      foundation: {
        name: WORKSPACE_FOUNDATION_MCP_NAME,
        command: "python3",
        args: [script],
        scriptPath: script,
        env: { PAPERCLIP_WORKSPACE_CWD: "/paperclip/projects/example" },
      },
    });
    expect(result.wrote).toBe(true);
    const config = fs.readFileSync(result.configPath, "utf8");
    expect(config).toContain('[mcp_servers."hive-workspace-foundation"]');
    expect(config).toContain('command = "python3"');
    expect(config).toContain(`[mcp_servers."hive-workspace-foundation".env]`);
    expect(config).toContain('PAPERCLIP_WORKSPACE_CWD = "/paperclip/projects/example"');
  });

  it("rewrites without orphaning a prior .env table", async () => {
    const home = tempDir();
    const script = path.join(home, "foundation.py");
    fs.writeFileSync(script, "print('ok')\n");
    const first = {
      name: WORKSPACE_FOUNDATION_MCP_NAME,
      command: "python3",
      args: [script],
      scriptPath: script,
      env: { PAPERCLIP_WORKSPACE_CWD: "/paperclip/projects/a" },
    };
    await ensureCodexHomeWorkspaceFoundation({ codexHome: home, foundation: first });
    await ensureCodexHomeWorkspaceFoundation({
      codexHome: home,
      foundation: { ...first, env: { PAPERCLIP_WORKSPACE_CWD: "/paperclip/projects/b" } },
    });
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(config.match(/\[mcp_servers\."hive-workspace-foundation"\.env\]/g)?.length).toBe(1);
    expect(config).toContain('PAPERCLIP_WORKSPACE_CWD = "/paperclip/projects/b"');
    expect(config).not.toContain('/paperclip/projects/a');
  });
});
