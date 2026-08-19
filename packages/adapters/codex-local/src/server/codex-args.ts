import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
  isCodexLocalFastModeSupported,
} from "../index.js";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
    /** Deployment-owned instructions delivered through Codex's native config. */
    systemInstructions?: string | null;
    /** HIVE's Codex vendor/base calibration file, kept separate from the rulebook. */
    modelInstructionsFile?: string | null;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const configuredModel = asString(record.model, "").trim();
  const model = configuredModel || DEFAULT_CODEX_LOCAL_MODEL;
  const configuredModelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const modelReasoningEffort = configuredModelReasoningEffort || DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);

  const args = ["exec", "--json"];
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (options.modelInstructionsFile?.trim()) {
    args.push("-c", `model_instructions_file=${JSON.stringify(options.modelInstructionsFile.trim())}`);
  }
  if (options.systemInstructions?.trim()) {
    args.push(
      "-c",
      `developer_instructions=${JSON.stringify(options.systemInstructions)}`,
      // System instructions are authoritative for programmatic Paperclip runs;
      // do not additionally discover a workspace AGENTS.md.
      "-c",
      "project_doc_max_bytes=0",
    );
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}
