// ZAC-265 round 4: the layout rules the owner asked for, held in the CSS (measured in the browser at
// 390px, DPR 3: the trail's icon on the tabs' mark column, x 24 = 24; the chips stuck at the scroll's top)
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");
const rule = (text: string, selector: string) => text.split("}").find((block) => block.trimStart().startsWith(`${selector} {`) || block.includes(`\n${selector} {`));

describe("the Agents lens's filter chips", () => {
  it("stay at the top of the sidebar's scroll on the panel's solid fill, edge to edge", () => {
    const facets = rule(css("AgentSidebar.css"), ".agent-facets");
    expect(facets).toContain("position: sticky;");
    expect(facets).toContain("top: 0;");
    expect(facets).toContain("background: var(--bg-panel);");
    expect(facets).toContain("margin-inline: calc(var(--side-gutter) * -1);");
  });
});

describe("the group trail", () => {
  it("sits on the tab row's columns: the strip's inset plus the tab's, one control high", () => {
    const open = rule(css("GroupTrail.css"), ".group-trail-open");
    expect(open).toContain("--trail-inset: calc(var(--space-3) * 2);");
    expect(open).toContain("padding: 0 var(--space-3) 0 var(--trail-inset);");
    expect(open).toContain("min-height: var(--control-h);");
    expect(open).toContain("align-items: center;");
    // the strip's and the tab's own insets, which the trail adds up
    const strip = css("TabStrip.css");
    expect(rule(strip, ".tab-strip")).toContain("padding: 0 var(--space-3);");
    expect(rule(strip, ".tab-strip-tab")).toContain("padding: 0 var(--space-3);");
  });
});
