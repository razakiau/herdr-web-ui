/**
 * "Other PCs (n)": with three PCs or more, the ones not in use fold into one row, styled as the
 * Agents fold, with small dots summing what works or asks on them (lib/hostPlacement.ts foldPcs).
 * Opened, each is a one-line row: its name, its dots, its state when not connected. Tapping one
 * opens it as a full group. The fold's open state is this device's (localStorage).
 */
import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Monitor } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";

const OPEN_KEY = "ovis:other-pcs-open";

/** What works and what asks on a PC: its agents' and its host chats'. */
export interface PcActivity { working: number; asking: number }

function storedOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

function Dots({ activity }: { activity: PcActivity }) {
  const t = useT();
  if (activity.working === 0 && activity.asking === 0) return null;
  const label = [activity.asking > 0 ? t("{n} asking", { n: activity.asking }) : null, activity.working > 0 ? t("{n} working", { n: activity.working }) : null].filter(Boolean).join(", ");
  return <span className="other-pcs-dots" role="img" aria-label={label} title={label}>
    {activity.asking > 0 && <span className="other-pcs-dot" data-status="blocked">{activity.asking}</span>}
    {activity.working > 0 && <span className="other-pcs-dot" data-status="working">{activity.working}</span>}
  </span>;
}

export function OtherPcsFold({ machines, activity, stateWord, onPick }: { machines: Machine[]; activity(machine: Machine): PcActivity; stateWord(machine: Machine): string; onPick(machineId: string): void }) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(storedOpen);
  const toggle = (): void => {
    setOpen(!open);
    try { localStorage.setItem(OPEN_KEY, open ? "0" : "1"); } catch { /* storage denied: the fold lasts for the page */ }
  };
  const total = machines.reduce((sum, machine) => { const each = activity(machine); return { working: sum.working + each.working, asking: sum.asking + each.asking }; }, { working: 0, asking: 0 });
  return <section className={`other-pcs${open ? "" : " is-collapsed"}`} aria-label={t("Other PCs")}>
    <button type="button" className="agent-section-toggle sidebar-section-label other-pcs-toggle" aria-expanded={open} aria-controls={listId} onClick={toggle}>
      {open ? <ChevronDown className="agent-section-caret" aria-hidden="true" /> : <ChevronRight className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Other PCs ({n})", { n: machines.length })}</span>
      <Dots activity={total} />
    </button>
    <ul className="other-pcs-list" id={listId} hidden={!open}>
      {machines.map((machine) => <li key={machine.id} className="other-pcs-item" data-machine={machine.id}>
        <button type="button" className="other-pcs-row" onClick={() => onPick(machine.id)}>
          <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
          <span className="other-pcs-name">{machine.name}</span>
          {machine.state !== "connected" && <span className="other-pcs-state">{stateWord(machine)}</span>}
          <Dots activity={activity(machine)} />
        </button>
      </li>)}
    </ul>
  </section>;
}
