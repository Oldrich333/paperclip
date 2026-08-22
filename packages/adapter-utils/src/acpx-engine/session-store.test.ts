import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { markAcpxSessionsForReset } from "./session-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function makeRecord(stateDir: string, sessionKey: string, acpx?: AcpSessionRecord["acpx"]): AcpSessionRecord {
  const now = new Date().toISOString();
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionKey,
    acpSessionId: `dead-${sessionKey}`,
    agentCommand: "codex-acp",
    cwd: process.cwd(),
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      active_path: path.join(stateDir, "events", "active.jsonl"),
      segment_count: 0,
      max_segment_bytes: 1024,
      max_segments: 2,
    },
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    ...(acpx ? { acpx } : {}),
  };
}

describe("markAcpxSessionsForReset", () => {
  it("marks every fingerprint for the task and leaves adjacent task records unchanged", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-reset-"));
    tempRoots.push(stateDir);
    const store = createRuntimeStore({ stateDir });
    const taskPrefix = "paperclip:company-1:agent-1:task-alpha";
    const matchingOne = `${taskPrefix}:fingerprint-one`;
    const matchingTwo = `${taskPrefix}:fingerprint-two`;
    const adjacentTask = "paperclip:company-1:agent-1:task-alphabet:fingerprint";

    await store.save(makeRecord(stateDir, matchingOne));
    await store.save(makeRecord(stateDir, matchingTwo, { reset_on_next_ensure: true }));
    await store.save(makeRecord(stateDir, adjacentTask));

    await expect(
      markAcpxSessionsForReset({
        stateDir,
        sessionKeyPrefix: taskPrefix,
      }),
    ).resolves.toBe(2);

    await expect((await store.load(matchingOne))?.acpx?.reset_on_next_ensure).toBe(true);
    await expect((await store.load(matchingTwo))?.acpx?.reset_on_next_ensure).toBe(true);
    await expect((await store.load(adjacentTask))?.acpx?.reset_on_next_ensure).toBeUndefined();
  });

  it("treats a missing state directory as an already-fresh reset", async () => {
    const stateDir = path.join(os.tmpdir(), "paperclip-acpx-reset-missing", randomUUID());

    await expect(
      markAcpxSessionsForReset({
        stateDir,
        sessionKeyPrefix: "paperclip:company-1:agent-1:",
      }),
    ).resolves.toBe(0);
  });
});
