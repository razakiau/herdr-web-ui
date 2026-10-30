/**
 * What the money went on, in the owner's plain words and one set of colours for every cost view
 * (ZAC-260): the Session sheet's Cost tab, the Costs sheet, All agents' rows and the footer chip.
 * Colours in SessionSheet.css (`.cost-part`). The Cost tab's total, `Hero`, is also the "This week" page's (ZAC-262).
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

/** "$57.10" as the total card prints it: "$" and the cents small and dim, whole dollars large; a floor's cents rounded down */
export function Hero({ usd, floor }: { usd: number; floor: boolean }) {
  const cents = Math.floor(usd * 100 + (floor ? 1e-9 : 0.5));
  const whole = Math.floor(cents / 100);
  return <div className="session-hero">
    {floor && <span className="session-hero-floor">≥</span>}
    <span className="session-hero-dollar">$</span>
    <span className="session-hero-whole">{whole.toLocaleString("en-US")}</span>
    <span className="session-hero-cents">.{String(cents % 100).padStart(2, "0")}</span>
  </div>;
}
