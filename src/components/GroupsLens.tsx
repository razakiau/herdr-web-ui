/**
 * Chat groups (ZAC-265), the sidebar's third lens (owner, 2026-11-01: Agents | Groups | PCs): every
 * group across the PCs as the Groups sheet's own cards (GroupsSheet.tsx GroupCard), the most recently
 * active first, in the sidebar's one scroll. A card opens the group's page (GroupsHost.tsx). Only
 * while Settings → Chat groups is on; MachineSidebar.tsx leaves the tab out otherwise.
 */
import { useMemo } from "react";

import "./NewSessionDialog.css";
import "./AllAgentsSheet.css";
import "./GroupsSheet.css";

import type { GroupsAnswer } from "../../shared/groups.ts";
import type { Machine } from "../../shared/machines.ts";
import { chatCosts, chatKey, costOf, groupsView } from "../lib/groups.ts";
import type { HostPc } from "../lib/hostChats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useCostsFeed } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { GroupCard, groupActive, rowsByKey } from "./GroupsSheet.tsx";

export function GroupsLens({ answer, failed, machines, hostChats }: {
  /** the groups as lib/groups.ts useGroups has them: null until the first answer */
  answer: GroupsAnswer | null; failed: boolean;
  machines: readonly Machine[]; hostChats: ReadonlyMap<string, HostPc>;
}) {
  const t = useT();
  const locale = useLocale();
  const { settings } = useSettings();
  const machineIds = useMemo(() => machines.filter((machine) => machine.state === "connected" && hostChats.has(machine.id)).map((machine) => machine.id), [machines, hostChats]);
  const feed = useCostsFeed(machineIds, settings.trackCosts);
  const costs = useMemo(() => chatCosts(feed), [feed]);
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  const groups = useMemo(() => [...answer?.groups ?? []].sort((a, b) => groupActive(b, rows) - groupActive(a, rows)), [answer, rows]);
  const pcName = (pc: string): string => machines.find((machine) => machine.id === pc)?.name ?? pc;
  return <section className="groups-lens" aria-label={t("Groups")}>
    {answer === null && <p className="agent-empty" role="status">{t(failed ? "Couldn't read the groups." : "Loading groups…")}</p>}
    {answer !== null && groups.length === 0 && <p className="agent-empty" role="status">{t("No groups yet. A chat that hands off to another starts one, or tap + to make one.")}</p>}
    {groups.length > 0 && <ul className="groups-list">
      {groups.map((group) => <GroupCard key={group.id} group={group} answer={answer!} rows={rows} pcName={pcName} locale={locale}
        total={costOf(group.members.map((member) => chatKey(member.pc, member.session)), costs)} onOpen={() => groupsView.openGroup(group.id)} />)}
    </ul>}
  </section>;
}
