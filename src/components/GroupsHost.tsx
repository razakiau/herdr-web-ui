/**
 * Chat groups (ZAC-265): what App draws of them, from lib/groups.ts's view store. The Groups sheet
 * (B), one group's page (E) over it, and "Add to group" for a chat. Nothing while Settings → Chat
 * groups is off. Costs come from the page's costs feed (lib/rowCache.ts), asked of the PCs that
 * are connected while costs are tracked and a view is open. A chat opened from a view closes them all.
 */
import { useMemo } from "react";

import type { Machine } from "../../shared/machines.ts";
import { chatCosts, groupsView, useGroups, useGroupsView } from "../lib/groups.ts";
import type { HostPc } from "../lib/hostChats.ts";
import { useCostsFeed } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { AddToGroupSheet } from "./AddToGroupSheet.tsx";
import { GroupPage } from "./GroupPage.tsx";
import { GroupsSheet } from "./GroupsSheet.tsx";

export function GroupsHost({ machines, hostChats, onOpenChat }: {
  machines: readonly Machine[];
  hostChats: ReadonlyMap<string, HostPc>;
  onOpenChat(target: { machineId: string; session: string }): void;
}) {
  const { settings } = useSettings();
  const on = settings.chatGroups;
  const view = useGroupsView();
  const open = on && (view.list || view.group !== null || view.addTo !== null);
  const groups = useGroups(on);
  const machineIds = useMemo(() => machines.filter((machine) => machine.state === "connected").map((machine) => machine.id), [machines]);
  const feed = useCostsFeed(machineIds, open && settings.trackCosts);
  const costs = useMemo(() => chatCosts(feed), [feed]);
  if (!open) return null;
  const answer = groups?.answer ?? null;
  const group = view.group === null ? null : answer?.groups.find((each) => each.id === view.group) ?? null;
  const openChat = (target: { machineId: string; session: string }): void => {
    groupsView.closeAll();
    onOpenChat(target);
  };
  return <>
    {view.list && <GroupsSheet answer={answer} failed={groups?.failed ?? false} machines={machines} hostChats={hostChats} costs={costs}
      onOpenGroup={(id) => groupsView.openGroup(id)} onClose={() => groupsView.closeList()} />}
    {group !== null && answer !== null && <GroupPage key={group.id} group={group} answer={answer} machines={machines} hostChats={hostChats} costs={costs}
      onOpenChat={openChat} onClose={() => groupsView.closeGroup()} />}
    {view.addTo !== null && <AddToGroupSheet key={`${view.addTo.pc} ${view.addTo.session}`} chat={view.addTo} answer={answer} hostChats={hostChats}
      onClose={() => groupsView.closeAddTo()} />}
  </>;
}
