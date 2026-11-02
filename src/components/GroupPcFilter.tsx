/**
 * Chat groups (ZAC-265, owner round 10): which PC's groups a list shows. A plain select (there may be
 * many PCs, so not chips), the app's own `.select`: All PCs, then each PC some group has a chat on.
 * Shown only when the groups span more than one PC; a group passes when any of its chats is on the
 * PC picked (lib/groups.ts groupOnPc).
 */
import "./GroupPcFilter.css";

import type { ChatGroup } from "../../shared/groups.ts";
import { useT } from "../lib/i18n.ts";

/** The PCs the groups have a chat on, in first-seen order. */
export function groupPcs(groups: readonly ChatGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => group.members.map((member) => member.pc)))];
}

export function GroupPcFilter({ pcs, value, pcName, onChange, className = "" }: {
  pcs: readonly string[];
  /** the PC picked, null for every PC */
  value: string | null;
  pcName(pc: string): string;
  onChange(pc: string | null): void;
  className?: string;
}) {
  const t = useT();
  if (pcs.length < 2) return null;
  return <select className={`select group-pc-filter ${className}`.trim()} aria-label={t("Show groups on")} value={value ?? ""}
    onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}>
    <option value="">{t("All PCs")}</option>
    {[...pcs].sort((a, b) => pcName(a).localeCompare(pcName(b))).map((pc) => <option key={pc} value={pc}>{pcName(pc)}</option>)}
  </select>;
}
