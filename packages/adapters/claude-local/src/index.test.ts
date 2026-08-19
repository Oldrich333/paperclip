import { describe, expect, it } from "vitest";

import { modelProfiles, models } from "./index.js";

describe("claude-local model defaults", () => {
  it("advertises the current Opus and Sonnet models", () => {
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["claude-opus-5", "claude-sonnet-5"]),
    );
  });

  it("uses Sonnet 5 for the cheap profile", () => {
    const cheap = modelProfiles.find((profile) => profile.key === "cheap");

    expect(cheap?.adapterConfig).toMatchObject({ model: "claude-sonnet-5", effort: "low" });
  });
});
