/**
 * Chat groups (ZAC-265), the sidebar's third lens (owner, 2026-11-01: Agents | Groups | PCs): every
 * group across the PCs as the Groups sheet's own cards (GroupsSheet.tsx GroupCard), the most recently
 * active first, in the sidebar's one scroll. A card opens the group's page (GroupsHost.tsx). Only
 * while Settings → Chat groups is on; MachineSidebar.tsx leaves the tab out otherwise.
 */
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";

import "./NewSessionDialog.css";
import "./AllAgentsSheet.css";
import "./GroupsSheet.css";

import type { GroupsAnswer } from "../../shared/groups.ts";
import type { Machine } from "../../shared/machines.ts";
import { chatCosts, chatKey, costOf, groupOnPc, groupsView } from "../lib/groups.ts";
import type { HostPc } from "../lib/hostChats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useCostsFeed } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { groupMatches } from "../lib/groupSuggest.ts";
import { groupPcs } from "./GroupPcFilter.tsx";
import { GroupCard, groupActive, rowsByKey } from "./GroupsSheet.tsx";

export function GroupsLens({ answer, failed, machines, hostChats, query = "", pc = null, limit, onMore }: {
  /** the groups as lib/groups.ts useGroups has them: null until the first answer */
  answer: GroupsAnswer | null; failed: boolean;
  machines: readonly Machine[]; hostChats: ReadonlyMap<string, HostPc>;
  /** the sidebar search's words: the groups whose name or a chat's title has every word (Add to group's matching) */
  query?: string;
  /** the PC picked in the search row (MachineSidebar), null for every PC */
  pc?: string | null;
  /** at most this many cards (the Agents search's short Groups section), with onMore for the rest */
  limit?: number;
  onMore?(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const { settings } = useSettings();
  const machineIds = useMemo(() => machines.filter((machine) => machine.state === "connected" && hostChats.has(machine.id)).map((machine) => machine.id), [machines, hostChats]);
  const feed = useCostsFeed(machineIds, settings.trackCosts);
  const costs = useMemo(() => chatCosts(feed), [feed]);
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  // the search row's PC filter and words (round 11: the PC select left of the sidebar's search, as in Add to group)
  const shownPc = pc !== null && groupPcs(answer?.groups ?? []).includes(pc) ? pc : null;
  const searching = query.trim() !== "";
  const matched = useMemo(() => [...answer?.groups ?? []].filter((group) => groupOnPc(group, shownPc) && groupMatches(group, rows, query))
    .sort((a, b) => groupActive(b, rows) - groupActive(a, rows)), [answer, rows, shownPc, query]);
  const groups = limit === undefined ? matched : matched.slice(0, limit);
  const pcName = (id: string): string => machines.find((machine) => machine.id === id)?.name ?? id;
  return <section className="groups-lens" aria-label={t("Groups")}>
    {answer === null && <p className="agent-empty" role="status">{t(failed ? "Couldn't read the groups." : "Loading groups…")}</p>}
    {answer !== null && matched.length === 0 && searching && <p className="agent-empty" role="status">{t("No group has “{query}” in its name or its chats.", { query: query.trim() })}</p>}
    {answer !== null && matched.length === 0 && !searching && shownPc !== null && <p className="agent-empty" role="status">{t("No group has a chat on {pc}.", { pc: pcName(shownPc) })}</p>}
    {answer !== null && matched.length === 0 && !searching && shownPc === null && <p className="agent-empty" role="status">{t("No groups yet. A chat that hands off to another starts one, or tap + to make one.")}</p>}
    {groups.length > 0 && <ul className="groups-list">
      {groups.map((group) => <GroupCard key={group.id} group={group} answer={answer!} rows={rows} pcName={pcName} locale={locale}
        total={costOf(group.members.map((member) => chatKey(member.pc, member.session)), costs)} onOpen={() => groupsView.openGroup(group.id)} />)}
    </ul>}
    {matched.length > groups.length && onMore && <button type="button" className="agent-more groups-lens-more" onClick={onMore}>
      <ChevronRight aria-hidden="true" />{t("Show all {n} in Groups", { n: matched.length })}
    </button>}
  </section>;
}
