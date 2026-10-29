/**
 * The sidebar footer's costs chip (ZAC-260, owner's option 2): every PC's Copilot chats at list
 * price for a period, "$212 · 7d", in whole dollars and without the "~", as clean as the plan
 * chips beside it (their `.usage-strip` button, no outline). It opens the Costs sheet. It asks each
 * PC with host chats for its costs as the sidebar mounts, every 5 minutes while it stays, and on
 * opening the sheet. Absent while costs are not tracked, and until a PC has answered with costs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import "./UsageMeters.css";
import "./CostsSheet.css";

import type { HostCostsAnswer } from "../../shared/host-chats.ts";
import { fetchModelPrices, type ChatPrices } from "../lib/api.ts";
import { wholeUsd } from "../lib/chatCost.ts";
import { fetchHostCosts } from "../lib/hostChats.ts";
import { useT } from "../lib/i18n.ts";
import { periodTotals, type CostPeriod } from "../lib/sessionCost.ts";
import { useSettings } from "../lib/settings.ts";
import { CostsSheet, PERIODS, type CostsPc } from "./CostsSheet.tsx";

/** How often the chip asks again while the sidebar is shown (plan, ZAC-260): costs move by the call, not by the second. */
const REFRESH_MS = 5 * 60_000;
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
  // per PC its last answer: null for a bridge before costs; a PC not answered yet (or down) has none
  const [answers, setAnswers] = useState<ReadonlyMap<string, HostCostsAnswer | null>>(() => new Map());
  const [prices, setPrices] = useState<ChatPrices | null>(null);
  const ids = pcs.map((pc) => pc.id).join("\n");

  const ask = useCallback(() => {
    void fetchModelPrices().then(setPrices);
    for (const machineId of ids === "" ? [] : ids.split("\n")) {
      // a down host keeps what it said last, and says nothing until it answers
      void fetchHostCosts(machineId).then((answer) => setAnswers((current) => new Map(current).set(machineId, answer)), () => {});
    }
  }, [ids]);

  useEffect(() => {
    if (!track) { setOpen(false); return; }
    ask();
    const timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") ask(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [track, ask]);

  // a PC no longer listed (removed, its host chats turned off) is let go
  const shown = useMemo(() => new Map([...answers].filter(([machineId]) => pcs.some((pc) => pc.id === machineId))), [answers, pcs]);
  const unpriced = prices !== null && prices.prices === null && prices.fallback === null;
  const totals = useMemo(() => prices && !unpriced ? periodTotals(shown, period, Date.now(), prices.prices ?? {}, prices.fallback) : null, [shown, period, prices, unpriced]);
  const oldBridge = [...shown].flatMap(([machineId, answer]) => answer === null ? [machineId] : []);
  const counted = [...shown.values()].some((answer) => answer !== null);

  if (!track || prices === null || !counted) return null;
  const short: Record<CostPeriod, string> = { today: t("today"), "7d": t("7d"), "30d": t("30d") };
  const usd = totals ? wholeUsd(totals.total.usd, totals.total.floor) : "—";
  const words = `${usd} · ${short[period]}`;
  return <>
    <button type="button" className="usage-strip costs-chip" aria-haspopup="dialog" aria-label={t("Chat costs: {usd}", { usd: words })} title={t("Chat costs: {usd}", { usd: words })}
      onClick={() => { ask(); setOpen(true); }}>
      <span className="usage-chip-value">{words}</span>
    </button>
    {open && <CostsSheet period={period} onPeriod={setPeriod} totals={totals} oldBridge={oldBridge} pcs={pcs}
      onPick={(machineId) => { setOpen(false); onAllAgents({ machineId, sort: "cost" }); }} onClose={() => setOpen(false)} />}
  </>;
}
