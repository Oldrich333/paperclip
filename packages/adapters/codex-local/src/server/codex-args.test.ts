import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for GPT-5.5", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "future-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "future-codex-model",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("uses Codex adapter defaults when model and reasoning are omitted", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain("gpt-5.6-luna");
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-",
    ]);
  });

  it("delivers deployment instructions natively and suppresses workspace discovery", () => {
    const result = buildCodexExecArgs({}, { systemInstructions: "shared contract" });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-c",
      'developer_instructions="shared contract"',
      "-c",
      "project_doc_max_bytes=0",
      "-",
    ]);
  });

  it("keeps the HIVE Codex base calibration separate from the developer rulebook", () => {
    const result = buildCodexExecArgs({}, {
      modelInstructionsFile: "/opt/hive-prompts/codex_model_instructions.md",
      systemInstructions: "shared contract",
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-c",
      'model_instructions_file="/opt/hive-prompts/codex_model_instructions.md"',
      "-c",
      'developer_instructions="shared contract"',
      "-c",
      "project_doc_max_bytes=0",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex-spark",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.6, gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex-spark",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-",
    ]);
  });

  it("ignores fast mode for gpt-5.4-mini", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "-",
    ]);
  });
});
