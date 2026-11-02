/**
 * Chat groups (ZAC-265, owner rounds 10 and 12): which PC's groups a list shows. All agents' sort pill
 * (PillMenu.tsx), not chips (there may be many PCs) nor a native select: All PCs, then each PC some group
 * has a chat on, each with the PC's Monitor icon.
 * Shown only when the groups span more than one PC; a group passes when any of its chats is on the
 * PC picked (lib/groups.ts groupOnPc).
 */
import "./GroupPcFilter.css";

import { Monitor } from "lucide-react";

import type { ChatGroup } from "../../shared/groups.ts";
import { useT } from "../lib/i18n.ts";
import { PillMenu } from "./PillMenu.tsx";

/** The PCs the groups have a chat on, in first-seen order. */
export function groupPcs(groups: readonly ChatGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => group.members.map((member) => member.pc)))];
}

const ALL = "\0all";

export function GroupPcFilter({ pcs, value, pcName, onChange, onOpenChange, className = "" }: {
  pcs: readonly string[];
  /** the PC picked, null for every PC */
  value: string | null;
  pcName(pc: string): string;
  onChange(pc: string | null): void;
  /** its menu opened or closed: a sheet under it gives up its Back entry and its Escape meanwhile */
  onOpenChange?(open: boolean): void;
  className?: string;
}) {
  const t = useT();
  if (pcs.length < 2) return null;
  const items = [{ value: ALL, label: t("All PCs"), icon: Monitor },
    ...[...pcs].sort((a, b) => pcName(a).localeCompare(pcName(b))).map((pc) => ({ value: pc, label: pcName(pc), icon: Monitor }))];
  const picked = value !== null && pcs.includes(value) ? value : ALL;
  return <PillMenu icon={Monitor} items={items} value={picked} title={t("Show groups on")}
    ariaLabel={t("Show groups on: {pc}", { pc: picked === ALL ? t("All PCs") : pcName(picked) })}
    onChange={(next) => onChange(next === ALL ? null : next)} onOpenChange={onOpenChange} className={`group-pc-filter ${className}`.trim()} />;
}
