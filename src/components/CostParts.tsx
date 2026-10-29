/**
 * What the money went on, in the owner's plain words and one set of colours for every cost view
 * (ZAC-260): the Session sheet's Cost tab, the Costs sheet, All agents' rows and the footer chip.
 * Colours in SessionSheet.css (`.cost-part`).
 */
import type { Translate } from "../lib/i18n.ts";
import type { CostSplit } from "../lib/sessionCost.ts";

export const COST_PARTS = ["reads", "writes", "restarts", "output", "fresh"] as const;
export type CostPart = typeof COST_PARTS[number];

export function partLabel(part: CostPart, t: Translate): string {
  switch (part) {
    case "reads": return t("Re-reading");
    case "writes": return t("Storing new text");
    case "restarts": return t("Cold restarts");
    case "output": return t("Answers");
    case "fresh": return t("New input");
  }
}

/** The split as a stacked bar, each part's share its width; nothing drawn for a $0 split. */
export function CostStack({ split, className }: { split: CostSplit; className: string }) {
  return <span className={`cost-stack ${className}`} aria-hidden="true">
    {split.usd > 0 && COST_PARTS.map((part) => split[part] > 0 && <span key={part} className={`cost-part is-${part}`} style={{ flexGrow: split[part] }} />)}
  </span>;
}
