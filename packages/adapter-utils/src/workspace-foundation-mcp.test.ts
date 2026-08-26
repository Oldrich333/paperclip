import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FOUNDATION_MCP_NAME,
  resolveWorkspaceFoundationMcpStdio,
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
    });
    expect(resolved).toEqual({
      name: WORKSPACE_FOUNDATION_MCP_NAME,
      command: "python3",
      args: [script],
      scriptPath: script,
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
  });
});
