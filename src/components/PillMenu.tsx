/**
 * A pick-one pill (All agents' sort chip, ZAC-260; the chat groups' PC filter, ZAC-265 round 12): a pill
 * on the raised ground with an icon, the pick's label and a chevron, outlined in amber while its menu is
 * open. The menu is RowMenu as a popover at every width, an icon per item and a check on the pick, so the
 * keyboard (arrows, Home/End, Escape, focus back on the pill) is RowMenu's. Drawn by AllAgentsSheet.css
 * (.all-agents-pill, .all-agents-sort).
 */
import { useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import "./AllAgentsSheet.css";

import { RowMenu } from "./RowMenu.tsx";

export interface PillMenuItem<V extends string> {
  value: V;
  /** the item's words in the menu */
  label: string;
  /** the pill's words while this item is the pick, when shorter than its label ("Cost" for "Cost, highest first") */
  short?: string;
  icon: LucideIcon;
}

export function PillMenu<V extends string>({ icon: Icon, items, value, title, ariaLabel, onChange, onOpenChange, className = "" }: {
  /** the pill's own icon, before its label */
  icon: LucideIcon;
  items: readonly PillMenuItem<V>[];
  value: V;
  /** the menu's accessible name ("Sort by") */
  title: string;
  /** the pill's accessible name, with the pick in it ("Sort: Recent") */
  ariaLabel: string;
  onChange(value: V): void;
  /** the menu opened or closed: a sheet under it gives up its Back entry and its Escape meanwhile */
  onOpenChange?(open: boolean): void;
  className?: string;
}) {
  const [anchor, setAnchorState] = useState<HTMLElement | null>(null);
  // told in the same render as the menu: the sheet under it hands over its Back entry as RowMenu takes one
  const setAnchor = (next: HTMLElement | null): void => { setAnchorState(next); onOpenChange?.(next !== null); };
  const picked = items.find((item) => item.value === value) ?? items[0];
  return <>
    <button type="button" className={`all-agents-pill all-agents-sort${anchor ? " is-open" : ""} ${className}`.trim()} aria-haspopup="menu" aria-expanded={anchor !== null}
      aria-label={ariaLabel} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
      <Icon aria-hidden="true" /><span className="all-agents-pill-name">{picked?.short ?? picked?.label}</span><ChevronDown aria-hidden="true" />
    </button>
    {anchor && <RowMenu anchor={anchor} align="start" popover title={title} onClose={() => setAnchor(null)}
      items={items.map((item) => ({ id: item.value, label: item.label, icon: item.icon, checked: item.value === value, run: () => onChange(item.value) }))} />}
  </>;
}
