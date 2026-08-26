import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfiguredOrManagedProjectCwd } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);

let tempHome: string;
let originalHome: string | undefined;

beforeAll(async () => {
  originalHome = process.env.PAPERCLIP_HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-configured-cwd-"));
  process.env.PAPERCLIP_HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

async function createLocalSourceRepo() {
  const sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-configured-source-"));
  await execFile("git", ["init"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "README.md"), "hello\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: sourceRepo });
  await execFile("git", ["commit", "-m", "init"], { cwd: sourceRepo });
  return sourceRepo;
}

describe("resolveConfiguredOrManagedProjectCwd git hardening", () => {
  it("rematerializes an empty configured managed path when a repo URL is present", async () => {
    const sourceRepo = await createLocalSourceRepo();
    const configuredCwd = path.join(tempHome, "projects", "company-empty", "project-1", "_default");
    await fs.mkdir(configuredCwd, { recursive: true });
    try {
      const result = await resolveConfiguredOrManagedProjectCwd({
        companyId: "company-empty",
        projectId: "project-1",
        cwd: configuredCwd,
        repoUrl: sourceRepo,
      });
      expect(result.cwd).toBe(configuredCwd);
      expect(result.warning).toBeNull();
      const gitDir = await fs.stat(path.join(configuredCwd, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("returns a valid configured git checkout unchanged", async () => {
    const sourceRepo = await createLocalSourceRepo();
    try {
      const result = await resolveConfiguredOrManagedProjectCwd({
        companyId: "company-valid",
        projectId: "project-1",
        cwd: sourceRepo,
        repoUrl: sourceRepo,
      });
      expect(result.cwd).toBe(sourceRepo);
      expect(result.warning).toBeNull();
      const gitDir = await fs.stat(path.join(sourceRepo, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("preserves an explicit non-git configured cwd when no repo URL is set", async () => {
    const configuredCwd = path.join(tempHome, "shared-non-git");
    await fs.mkdir(configuredCwd, { recursive: true });
    await fs.writeFile(path.join(configuredCwd, "notes.txt"), "shared\n", "utf8");
    const result = await resolveConfiguredOrManagedProjectCwd({
      companyId: "company-nongit",
      projectId: "project-1",
      cwd: configuredCwd,
      repoUrl: null,
    });
    expect(result.cwd).toBe(configuredCwd);
    expect(result.warning).toBeNull();
    await expect(fs.stat(path.join(configuredCwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
