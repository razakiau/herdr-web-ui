/**
 * The Costs sheet (ZAC-260, owner's option 2): what the sidebar's costs chip opens. Today, 7 days
 * or 30 days of every PC's Copilot chats at list price: the total, what the money went on (the
 * Session sheet's stack and colours), and By PC each PC's sum, its chats that made calls in the
 * period and the costliest of them. Tapping a PC opens its All agents sorted by Cost. A PC whose
 * bridge predates costs is named under the total and left out of the sums. Under the periods, once
 * the weekly digest has saved a week, "This week" opens its page (ZAC-262, WeekSheet.tsx).
 */
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./NewSessionDialog.css";
import "./SessionSheet.css";
import "./CostsSheet.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { listUsd } from "../lib/chatCost.ts";
import { useT } from "../lib/i18n.ts";
import type { CostPeriod, PeriodTotals } from "../lib/sessionCost.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { hostChatTitle } from "./HostChatActions.tsx";
import { COST_PARTS, CostStack, partLabel } from "./CostParts.tsx";

/** A PC the sheet can name: its name, and its host chats for the costliest one's title. */
export interface CostsPc { id: string; name: string; chats: readonly HostChatRow[] }

export const PERIODS: readonly CostPeriod[] = ["today", "7d", "30d"];

export interface CostsSheetProps {
  period: CostPeriod;
  onPeriod(period: CostPeriod): void;
  /** null while prices are unavailable: no figures then, rather than $0 floors */
  totals: PeriodTotals | null;
  /** the PCs whose bridge predates costs, even with no prices */
  oldBridge: readonly string[];
  pcs: readonly CostsPc[];
  onPick(machineId: string): void;
  /** the weekly digest's "This week" page (ZAC-262); absent while no week is saved */
  onThisWeek?: (() => void) | undefined;
  onClose(): void;
}

export function CostsSheet({ period, onPeriod, totals, oldBridge, pcs, onPick, onThisWeek, onClose }: CostsSheetProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => onClose());
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const nameOf = (machineId: string): string => pcs.find((pc) => pc.id === machineId)?.name ?? machineId;
  const total = totals?.total;
  const share = (value: number): string => total && total.usd > 0 ? `${Math.round((value / total.usd) * 100)}%` : "0%";
  const label: Record<CostPeriod, string> = { today: t("Today"), "7d": t("7 days"), "30d": t("30 days") };
  // a PC that made no call in the period has nothing to say here
  const spent = totals?.pcs.filter((pc) => pc.chats > 0) ?? [];

  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal new-session-modal costs-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Costs")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body costs-body">
          <div className="segmented costs-periods" role="group" aria-label={t("Period")}>
            {PERIODS.map((each) => <button key={each} type="button" aria-pressed={period === each} onClick={() => onPeriod(each)}>{label[each]}</button>)}
          </div>
          {onThisWeek && <button type="button" className="btn btn-ghost costs-this-week" onClick={onThisWeek}>{t("This week")}</button>}
          {total ? <>
            <p className="costs-total"><strong className={total.floor ? "is-floor" : undefined}>{listUsd(total.usd, total.floor)}</strong><span>{t("Copilot chats")}</span></p>
            {oldBridge.map((machineId) => <p key={machineId} className="field-hint costs-old-bridge">{t("{pc}: update the bridge to count it", { pc: nameOf(machineId) })}</p>)}
            {/* what the money went on, the Session sheet's Cost tab's words and colours */}
            <CostStack split={total} className="costs-stack" />
            {total.usd > 0 && <ul className="costs-legend">
              {COST_PARTS.filter((part) => total[part] > 0).map((part) => <li key={part}><span className={`cost-dot cost-part is-${part}`} aria-hidden="true" />{partLabel(part, t)} {share(total[part])}</li>)}
            </ul>}
            {total.missing.length > 0 && <p className="field-hint">{t("No price for {models}.", { models: total.missing.join(", ") })}</p>}
            {total.floor && total.missing.length === 0 && <p className="field-hint">{t("Some logs are not fully read yet: at least this much.")}</p>}
            {spent.length > 0 && <section className="costs-group" aria-labelledby={`${id}-pcs`}>
              <h3 className="sidebar-section-label costs-group-head" id={`${id}-pcs`}>{t("By PC")}</h3>
              <ul className="costs-pcs">
                {spent.map((pc) => {
                  const row = pc.biggest ? pcs.find((each) => each.id === pc.machineId)?.chats.find((chat) => chat.session === pc.biggest!.session) : undefined;
                  const title = row ? hostChatTitle(row, t) : t("Copilot chat");
                  const meta = [
                    pc.chats === 1 ? t("1 chat") : t("{n} chats", { n: pc.chats }),
                    pc.biggest ? t("biggest: {title} {usd}", { title, usd: listUsd(pc.biggest.split.usd, pc.biggest.split.floor) }) : null,
                  ].filter(Boolean).join(" · ");
                  return <li key={pc.machineId}>
                    <button type="button" className="costs-pc" onClick={() => onPick(pc.machineId)}>
                      <span className="costs-pc-line">
                        <span className="costs-pc-name">{nameOf(pc.machineId)}</span>
                        <span className="costs-pc-cost">
                          <span className={`costs-pc-usd${pc.split.floor ? " is-floor" : ""}`}>{pc.split.usd === 0 && pc.split.local.length > 0 ? t("$0 · local") : listUsd(pc.split.usd, pc.split.floor)}</span>
                          {pc.split.usd > 0 && <CostStack split={pc.split} className="cost-mini" />}
                        </span>
                      </span>
                      <span className="costs-pc-meta">{meta}</span>
                    </button>
                  </li>;
                })}
              </ul>
              <p className="field-hint">{t("Tap a PC to see its chats by cost.")}</p>
            </section>}
          </> : <>
            <p className="field-hint" role="status">{t("Prices are unavailable: costs not shown.")}</p>
            {oldBridge.map((machineId) => <p key={machineId} className="field-hint costs-old-bridge">{t("{pc}: update the bridge to count it", { pc: nameOf(machineId) })}</p>)}
          </>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
