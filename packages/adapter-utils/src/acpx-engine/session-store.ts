import fs from "node:fs/promises";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";

export interface AcpxSessionResetInput {
  stateDir: string;
  sessionKeyPrefix: string;
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Mark persisted ACPX records for one Paperclip task so the next persistent
 * ensure creates a fresh backend session instead of reusing a stale record.
 * The marker is ACPX's supported reset contract; unrelated task records stay
 * untouched and malformed records remain non-resumable by ACPX itself.
 */
export async function markAcpxSessionsForReset(input: AcpxSessionResetInput): Promise<number> {
  const stateDir = input.stateDir.trim();
  const sessionKeyPrefix = input.sessionKeyPrefix.trim();
  if (!stateDir || !sessionKeyPrefix) return 0;

  const normalizedPrefix = sessionKeyPrefix.endsWith(":")
    ? sessionKeyPrefix
    : `${sessionKeyPrefix}:`;
  const sessionsDir = path.join(path.resolve(stateDir), "sessions");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) return 0;
    throw error;
  }

  const store = createRuntimeStore({ stateDir: path.resolve(stateDir) });
  let marked = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    let sessionKey: string;
    try {
      sessionKey = decodeURIComponent(entry.name.slice(0, -".json".length));
    } catch {
      continue;
    }
    if (!sessionKey.startsWith(normalizedPrefix)) continue;

    const record = await store.load(sessionKey);
    if (!record || record.acpxRecordId !== sessionKey) continue;
    marked += 1;
    if (record.acpx?.reset_on_next_ensure === true) continue;

    const updated: AcpSessionRecord = {
      ...record,
      acpx: {
        ...record.acpx,
        reset_on_next_ensure: true,
      },
    };
    await store.save(updated);
  }

  return marked;
}
