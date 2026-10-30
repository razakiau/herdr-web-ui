/**
 * The sidebar footer's costs chip (ZAC-260, owner's pick D2): every PC's Copilot chats at list
 * price for a period, built like the plan chips beside it (their `.usage-strip` button, no
 * outline): "$5,849" with the period in small caps ("30D") over the same thin bar, split in the
 * cost colours. No "≥" here: a floor only dims the amount, the Costs sheet says how. It opens the Costs sheet. It asks each
 * PC with host chats for its costs through the page's feed (lib/rowCache.ts) as the sidebar mounts, every 5 minutes while it stays, and on
 * opening the sheet. Absent while costs are not tracked, and until a PC has answered with costs.
 */
import { useEffect, useMemo, useState } from "react";

import "./UsageMeters.css";
import "./SessionSheet.css";
import "./CostsSheet.css";

import type { HostCostsAnswer } from "../../shared/host-chats.ts";
import { wholeUsd } from "../lib/chatCost.ts";
import { CostStack } from "./CostParts.tsx";
import { costsFeed, useCostsFeed } from "../lib/rowCache.ts";
import { useT } from "../lib/i18n.ts";
import { periodTotals, type CostPeriod } from "../lib/sessionCost.ts";
import { useSettings } from "../lib/settings.ts";
import { CostsSheet, PERIODS, type CostsPc } from "./CostsSheet.tsx";

const EMPTY_ANSWERS: ReadonlyMap<string, HostCostsAnswer | null> = new Map();
const PERIOD_KEY = "ovis:costs-period";

function storedPeriod(): CostPeriod {
  try {
    const value = localStorage.getItem(PERIOD_KEY);
    return PERIODS.find((each) => each === value) ?? "7d";
  } catch { return "7d"; }
}

export interface CostsChipProps {
  /** the PCs with host chats (the sidebar's groups) */
  pcs: readonly CostsPc[];
  /** a PC tapped in the sheet: its All agents, sorted by Cost */
  onAllAgents(on: { machineId: string; sort: "cost" }): void;
}

export function CostsChip({ pcs, onAllAgents }: CostsChipProps) {
  const t = useT();
  const { settings } = useSettings();
  const track = settings.trackCosts;
  const [open, setOpen] = useState(false);
  const [period, setPeriodState] = useState<CostPeriod>(storedPeriod);
  const setPeriod = (next: CostPeriod): void => {
    setPeriodState(next);
    try { localStorage.setItem(PERIOD_KEY, next); } catch { /* storage denied: for the page */ }
  };
  // per PC its last answer (null for a bridge before costs; a PC not answered yet, or down, has
  // none) and the prices: the page's costs feed (lib/rowCache.ts), shared with the lists' cache marks
  const ids = useMemo(() => pcs.map((pc) => pc.id), [pcs]);
  const feed = useCostsFeed(ids, track);
  const answers = feed?.answers ?? EMPTY_ANSWERS;
  const prices = feed?.prices ?? null;
  const ask = costsFeed.ask;
  useEffect(() => { if (!track) setOpen(false); }, [track]);

  // a PC no longer listed (removed, its host chats turned off) is let go
  const shown = useMemo(() => new Map([...answers].filter(([machineId]) => pcs.some((pc) => pc.id === machineId))), [answers, pcs]);
  const unpriced = prices !== null && prices.prices === null && prices.fallback === null;
  const totals = useMemo(() => prices && !unpriced ? periodTotals(shown, period, Date.now(), prices.prices ?? {}, prices.fallback) : null, [shown, period, prices, unpriced]);
  const oldBridge = [...shown].flatMap(([machineId, answer]) => answer === null ? [machineId] : []);
  const counted = [...shown.values()].some((answer) => answer !== null);

  if (!track || prices === null || !counted) return null;
  const short: Record<CostPeriod, string> = { today: t("today"), "7d": t("7d"), "30d": t("30d") };
  const usd = totals ? wholeUsd(totals.total.usd, false) : "—";
  const floor = totals?.total.floor ?? false;
  const words = `${usd} ${short[period]}`;
  // the chip draws a floor dimmed, with no "≥": its label says it in words, which a screen reader speaks
  const label = t(floor ? "Chat costs: at least {usd}" : "Chat costs: {usd}", { usd: words });
  return <>
    <button type="button" className="usage-strip costs-chip" aria-haspopup="dialog" aria-label={label} title={label}
      onClick={() => { ask(); setOpen(true); }}>
      <span className={`costs-chip-body${floor ? " is-floor" : ""}`}>
        <span className="costs-chip-top"><span className="costs-chip-usd">{usd}</span><span className="costs-chip-period">{short[period]}</span></span>
        {totals && <CostStack split={totals.total} className="costs-chip-bar" />}
      </span>
    </button>
    {open && <CostsSheet period={period} onPeriod={setPeriod} totals={totals} oldBridge={oldBridge} pcs={pcs}
      onPick={(machineId) => { setOpen(false); onAllAgents({ machineId, sort: "cost" }); }} onClose={() => setOpen(false)} />}
  </>;
}
