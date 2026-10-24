import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stylesheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? stylesheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

/** The endless `animation` declarations that are not stepped, whole and on one line. */
function smoothEndless(css: string): string[] {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split(/[;{}]/).map((declaration) => declaration.replace(/\s+/g, " ").trim())
    .filter((declaration) => /^animation\s*:/.test(declaration) && /\binfinite\b/.test(declaration)
      && !/var\(--ease-(pulse|spin|breathe|shimmer)\)/.test(declaration) && !/bridge-progress-slide/.test(declaration));
}

const ENDLESS_EASINGS = ["--ease-pulse", "--ease-spin", "--ease-breathe", "--ease-shimmer"];

/** The value each endless easing token takes in the first rule whose selector is exactly `selector`. */
function easings(css: string, selector: string): Record<string, string> {
  const body = new RegExp(`(^|})\\s*${selector.replace(/[[\]"=]/g, "\\$&")}\\s*{([^}]*)}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[2] ?? "";
  return Object.fromEntries(ENDLESS_EASINGS.map((name) => [name, new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? ""]));
}

describe("motion", () => {
  // A smooth endless animation has the browser draw a frame at every display refresh while it
  // runs (an agent works for minutes), which stutters a video playing next to the app. An endless
  // one jumps between steps instead; only the bridge install's progress bar, shown while it
  // installs, slides.
  it("runs no endless animation smoothly, apart from the bridge install's progress bar", () => {
    expect(stylesheets(import.meta.dir).flatMap((file) =>
      smoothEndless(readFileSync(file, "utf8")).map((declaration) => `${file.slice(import.meta.dir.length + 1)}: ${declaration}`))).toEqual([]);
  });

  // Settings > Appearance > Smooth animations (off by default) lets an account that runs no video
  // beside the app trade that for motion drawn every frame: the root's data-motion="smooth" swaps
  // each endless easing token for a smooth one, so every endless animation must use one.
  it("steps every endless easing token by default and smooths each one under data-motion=smooth", () => {
    const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
    const stepped = easings(css, ":root");
    const smooth = easings(css, '[data-motion="smooth"]');
    for (const name of ENDLESS_EASINGS) {
      expect(`${name}: ${stepped[name]}`).toMatch(new RegExp(`^${name}: steps\\(`));
      expect(`${name}: ${smooth[name]}`).toMatch(new RegExp(`^${name}: (linear|ease|ease-in-out|cubic-bezier\\()`));
    }
  });

  // one sign for "in progress" (owner, ZAC-228): the sidebar's dot, a tab's dot and glyph and a
  // working group's dot all breathe with the same keyframes, so lib/breath.ts keeps them in step
  it("breathes every working dot as the sidebar's does", () => {
    const rules = (file: string) => readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const breathes = (css: string, selector: string) => new RegExp(`${selector.replace(/[[\]"=.]/g, "\\$&")}[^{]*{[^}]*animation:\\s*sidebar-breathe`).test(css);
    expect(breathes(rules("components/Sidebar.css"), '.sidebar-status[data-status="working"] .sidebar-status-dot')).toBe(true);
    expect(breathes(rules("components/TabStrip.css"), '.tab-strip-dot[data-status="working"]')).toBe(true);
    expect(breathes(rules("components/ChatView.css"), ".work-block-dot")).toBe(true);
  });

  it("reads a declaration whole, however it is split across lines", () => {
    expect(smoothEndless(".a {\n  animation: pulse 1.6s\n    ease-in-out\n    infinite;\n}")).toEqual(["animation: pulse 1.6s ease-in-out infinite"]);
    expect(smoothEndless(".a { animation:\n  pulse var(--dur-pulse) var(--ease-pulse)\n  infinite }")).toEqual([]);
    expect(smoothEndless("/* animation: pulse 1s infinite; */ .a { animation: fade 1s; }")).toEqual([]);
  });
});
