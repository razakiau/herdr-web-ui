/**
 * Chat groups (ZAC-265): what App draws of them, from lib/groups.ts's view store. The Groups sheet
 * (B), one group's page (E) over it, and "Add to group" for a chat. Nothing while Settings → Chat
 * groups is off. Costs come from the page's costs feed (lib/rowCache.ts), asked of the PCs that
 * are connected while costs are tracked and a view is open, and the group's page draws each row's
 * cache ring from the same feed. A chat (or a file) opened from a view closes them all.
 */
import { useEffect, useMemo } from "react";

import type { Machine } from "../../shared/machines.ts";
import { useGroupDigest } from "../lib/groupDigest.ts";
import { chatCosts, groupsView, liveGroups, useGroups, useGroupsView } from "../lib/groups.ts";
import type { HostPc } from "../lib/hostChats.ts";
import { useCostsFeed } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { AddToGroupSheet } from "./AddToGroupSheet.tsx";
import { GroupPage } from "./GroupPage.tsx";
import { GroupsSheet } from "./GroupsSheet.tsx";

export function GroupsHost({ machines, hostChats, onOpenChat, onOpenFile }: {
  machines: readonly Machine[];
  hostChats: ReadonlyMap<string, HostPc>;
  onOpenChat(target: { machineId: string; session: string }): void;
  /** a file artifact of a group's page, in herdr's viewer on its chat's PC */
  onOpenFile?(target: { machineId: string; path: string }): void;
}) {
  const { settings } = useSettings();
  const on = settings.chatGroups;
  const view = useGroupsView();
  const open = on && (view.list || view.group !== null || view.addTo !== null);
  const groups = useGroups(on);
  const machineIds = useMemo(() => machines.filter((machine) => machine.state === "connected").map((machine) => machine.id), [machines]);
  const feed = useCostsFeed(machineIds, open && settings.trackCosts);
  const costs = useMemo(() => chatCosts(feed), [feed]);
  // a chat its host says is gone (deleted) is hidden from every group sheet; an offline PC's stay
  const answer = useMemo(() => liveGroups(groups?.answer ?? null, hostChats), [groups?.answer, hostChats]);
  // the open group deleted (here or elsewhere): its page goes, back to what was under it
  const gone = view.group !== null && answer !== null && !answer.groups.some((each) => each.id === view.group);
  useEffect(() => { if (gone) groupsView.closeGroup(); }, [gone]);
  // the open group's digest (lib/groupDigest.ts): read as its page opens, and on each groups nudge
  const digestStore = useGroupDigest(on && view.group !== null ? view.group : null);
  if (!open) return null;
  const group = view.group === null ? null : answer?.groups.find((each) => each.id === view.group) ?? null;
  const openChat = (target: { machineId: string; session: string }): void => {
    groupsView.closeAll();
    onOpenChat(target);
  };
  return <>
    {view.list && <GroupsSheet answer={answer} failed={groups?.failed ?? false} machines={machines} hostChats={hostChats} costs={costs}
      onOpenGroup={(id) => groupsView.openGroup(id)} onClose={() => groupsView.closeList()} />}
    {group !== null && answer !== null && <GroupPage key={group.id} group={group} answer={answer} machines={machines} hostChats={hostChats} costs={costs} feed={feed} from={view.from}
      digest={digestStore ? (() => {
        const state = digestStore.state();
        const meta = answer.digests.find((each) => each.groupId === group.id);
        return { digest: state.digest, progress: state.progress, failure: state.failure, spentUsd: Math.max(state.spentUsd, meta?.spentUsd ?? 0),
          spendIncomplete: state.spendIncomplete || meta?.spendIncomplete === true,
          models: digestStore.models() ?? undefined, estimate: digestStore.estimate, onWrite: (pick) => { void digestStore.write(pick); } };
      })() : undefined}
      onOpenChat={openChat} onOpenFile={onOpenFile ? (target) => { groupsView.closeAll(); onOpenFile(target); } : undefined} onClose={() => groupsView.closeGroup()} />}
    {view.addTo !== null && <AddToGroupSheet key={`${view.addTo.pc} ${view.addTo.session}`} chat={view.addTo} answer={answer} hostChats={hostChats} feed={feed}
      onClose={() => groupsView.closeAddTo()} />}
  </>;
}
