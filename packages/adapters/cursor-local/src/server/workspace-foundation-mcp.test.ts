import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_FOUNDATION_MCP_NAME } from "@paperclipai/adapter-utils/workspace-foundation-mcp";
import { writeCursorWorkspaceFoundationMcp } from "./workspace-foundation-mcp.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("writeCursorWorkspaceFoundationMcp", () => {
  it("writes hive-workspace-foundation into $HOME/.cursor/mcp.json without dropping peers", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-foundation-"));
    tempDirs.push(home);
    const cursorDir = path.join(home, ".cursor");
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { peer: { url: "https://example.test/mcp" } } }),
      "utf8",
    );
    const script = path.join(home, "foundation.py");
    await fs.writeFile(script, "print('ok')\n");

    const result = await writeCursorWorkspaceFoundationMcp({
      homeDir: home,
      env: {
        HIVE_WORKSPACE_FOUNDATION_MCP: script,
        PAPERCLIP_WORKSPACE_CWD: "/paperclip/projects/example",
        HIVE_WORKSPACE_EXTRA_ROOTS: "/opt/hive20",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.configPath).toBe(path.join(cursorDir, "mcp.json"));
    const parsed = JSON.parse(await fs.readFile(result!.configPath, "utf8")) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; url?: string; env?: Record<string, string> }
      >;
    };
    expect(parsed.mcpServers.peer.url).toBe("https://example.test/mcp");
    expect(parsed.mcpServers[WORKSPACE_FOUNDATION_MCP_NAME]).toEqual({
      command: "python3",
      args: [script],
      env: {
        PAPERCLIP_WORKSPACE_CWD: "/paperclip/projects/example",
        HIVE_WORKSPACE_EXTRA_ROOTS: "/opt/hive20",
      },
    });
  });
});
