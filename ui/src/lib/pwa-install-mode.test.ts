import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("PWA install mode", () => {
  it("launches from the home screen as a chromeless standalone app", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      display?: string;
    };
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");

    // Chrome/Android drops the URL bar on an installed app only for a chromeless
    // display mode; iOS honors add-to-home-screen standalone only via the legacy
    // metas. Navigation recovery inside that window is StandaloneBrowserControls'
    // job — see ui/src/components/StandaloneBrowserControls.tsx.
    expect(manifest.display).toBe("standalone");
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
  });

  it("meets the Android/Chrome installability criteria", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      name?: string;
      start_url?: string;
      icons?: Array<{ sizes?: string; purpose?: string }>;
    };

    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    const sizes = new Set((manifest.icons ?? []).map((icon) => icon.sizes));
    expect(sizes.has("192x192")).toBe(true);
    expect(sizes.has("512x512")).toBe(true);
    expect((manifest.icons ?? []).some((icon) => (icon.purpose ?? "").includes("maskable"))).toBe(true);
  });
});
