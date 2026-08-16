import { describe, expect, it } from "vitest";

import {
  effectiveScopeBindings,
  narrowestScopeBindings,
} from "./tool-profile-binding-precedence.js";

const createdAt = new Date("2026-08-16T00:00:00Z");

function binding(
  profileId: string,
  targetType: "company" | "project" | "agent" | "issue" | "gateway",
  priority = 100,
  metadata: Record<string, unknown> = {},
) {
  return { profileId, targetType, priority, createdAt, metadata };
}

describe("narrowestScopeBindings", () => {
  it("keeps ordinary company profiles replaceable by a narrower context", () => {
    expect(narrowestScopeBindings([
      binding("company-default", "company"),
      binding("issue-working-set", "issue"),
    ]).map((row) => row.profileId)).toEqual(["issue-working-set"]);
  });

  it("composes an explicit company baseline after the narrowest context", () => {
    expect(effectiveScopeBindings([
      binding("memory-foundation", "company", 100, { bindingMode: "baseline" }),
      binding("company-default", "company"),
      binding("agent-working-set", "agent"),
      binding("issue-working-set", "issue"),
    ]).map((row) => row.profileId)).toEqual([
      "issue-working-set",
      "memory-foundation",
    ]);
  });

  it("keeps the ordinary company set unchanged when company is already the narrowest scope", () => {
    expect(effectiveScopeBindings([
      binding("memory-foundation", "company", 100, { bindingMode: "baseline" }),
      binding("company-default", "company"),
    ]).map((row) => row.profileId)).toEqual(["company-default", "memory-foundation"]);
  });

  it("does not promote a non-company baseline marker", () => {
    expect(effectiveScopeBindings([
      binding("agent-baseline-marker", "agent", 100, { bindingMode: "baseline" }),
      binding("issue-working-set", "issue"),
    ]).map((row) => row.profileId)).toEqual(["issue-working-set"]);
  });

  it("leaves strict narrowest-scope resolution unchanged for privilege checks", () => {
    expect(narrowestScopeBindings([
      binding("memory-foundation", "company", 100, { bindingMode: "baseline" }),
      binding("gateway-working-set", "gateway"),
    ]).map((row) => row.profileId)).toEqual(["gateway-working-set"]);
  });

  it("does not implicitly add a company baseline to a named gateway", () => {
    expect(effectiveScopeBindings([
      binding("memory-foundation", "company", 100, { bindingMode: "baseline" }),
      binding("gateway-working-set", "gateway"),
    ]).map((row) => row.profileId)).toEqual(["gateway-working-set"]);
  });

  it("keeps an authenticated named gateway closed after its last explicit binding is removed", () => {
    expect(effectiveScopeBindings([
      binding("memory-foundation", "company", 100, { bindingMode: "baseline" }),
      binding("agent-working-set", "agent"),
    ], "gateway")).toEqual([]);
  });
});
