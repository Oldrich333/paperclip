import type { ToolProfileBindingTargetType } from "@paperclipai/shared";

type BindingLike = {
  profileId: string;
  targetType: ToolProfileBindingTargetType;
  priority: number;
  createdAt: Date | string;
  metadata?: unknown;
};

const TOOL_PROFILE_SCOPE_PRECEDENCE: Record<ToolProfileBindingTargetType, number> = {
  // Named gateways bind one concrete MCP endpoint instance, so they should
  // override broader run, agent, and company defaults when both match.
  gateway: 0,
  issue: 1,
  routine: 2,
  agent: 3,
  project: 4,
  company: 5,
};

function createdAtMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function toolProfileBindingScopePrecedence(targetType: ToolProfileBindingTargetType): number {
  return TOOL_PROFILE_SCOPE_PRECEDENCE[targetType];
}

export function narrowestScopeBindings<T extends BindingLike>(bindings: T[]): T[] {
  if (bindings.length === 0) return [];
  const winningScope = Math.min(...bindings.map((binding) => toolProfileBindingScopePrecedence(binding.targetType)));
  return bindings
    .filter((binding) => toolProfileBindingScopePrecedence(binding.targetType) === winningScope)
    .sort((a, b) =>
      a.priority - b.priority
      || createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt)
      || a.profileId.localeCompare(b.profileId)
    );
}

function isRequiredCompanyBaseline(binding: BindingLike): boolean {
  if (binding.targetType !== "company" || typeof binding.metadata !== "object" || binding.metadata === null) {
    return false;
  }
  return (binding.metadata as Record<string, unknown>).bindingMode === "baseline";
}

/**
 * Compose explicitly marked company foundations with the narrowest normal working-set scope.
 * Do not use this helper for connection-token mint authority, where strict narrowest-scope
 * replacement remains a privilege boundary.
 */
export function effectiveScopeBindings<T extends BindingLike>(
  bindings: T[],
  boundaryTargetType: "gateway" | null = null,
): T[] {
  const contextual = narrowestScopeBindings(bindings);
  // A named gateway is an explicit external capability boundary. It receives
  // only profiles bound to that gateway; founder/operator gateways that need
  // company memory must bind the memory profile explicitly. The boundary is
  // derived from the authenticated run context, not from the continued
  // existence of a binding row: removing the last gateway binding must leave
  // the gateway deny-by-default rather than exposing agent/company profiles.
  if (boundaryTargetType === "gateway") {
    return contextual.filter((binding) => binding.targetType === "gateway");
  }
  if (contextual.length === 0 || contextual[0]?.targetType === "company" || contextual[0]?.targetType === "gateway") {
    return contextual;
  }
  const seen = new Set(contextual.map((binding) => binding.profileId));
  const baselines = bindings
    .filter((binding) => isRequiredCompanyBaseline(binding) && !seen.has(binding.profileId))
    .sort((a, b) =>
      a.priority - b.priority
      || createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt)
      || a.profileId.localeCompare(b.profileId)
    );
  return [...contextual, ...baselines];
}

export function profileIdsInBindingOrder<T extends Pick<BindingLike, "profileId">>(bindings: T[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.profileId)) continue;
    seen.add(binding.profileId);
    ordered.push(binding.profileId);
  }
  return ordered;
}
