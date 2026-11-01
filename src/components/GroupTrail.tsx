/**
 * Chat groups (ZAC-265), the bar in a chat that is in a group (owner's v2): one line under the
 * header, "▤ Ovis keep-warm follow-ups · 3 chats · 1 working · 1 warm ›", the whole line one tap
 * to the group's page. The name drops a leading ticket ("ZAC-262 ") for the bar only (lib/groups.ts
 * trailName) and is what gives way, with an ellipsis; the count and the state never do. The state
 * is the rows' own (GroupState.tsx): nothing when every chat is idle and cold. Nothing at all while
 * Settings → Chat groups is off or the chat is in no group.
 */
import { useMemo } from "react";
import { ChevronRight, GalleryVerticalEnd } from "lucide-react";

import "./GroupTrail.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { chatKey, groupOf, groupsView, trailName, useGroups } from "../lib/groups.ts";
import { useT } from "../lib/i18n.ts";
import { useCostsFeed } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { GroupStateSummary, hasGroupState, useMemberStates } from "./GroupState.tsx";

export function GroupTrail({ machineId, session, chats }: {
  machineId: string; session: string;
  /** this chat's title, before its PC's list has it (unused by the bar since v2; kept for its callers) */
  title?: string;
  /** the PC's chats, for the members' states */
  chats: readonly HostChatRow[] | undefined;
  /** unused since v2: the bar opens the group's page, which opens a chat */
  onOpenChat?(session: string): void;
}) {
  const { settings } = useSettings();
  const groups = useGroups(settings.chatGroups);
  const group = groupOf(groups?.answer ?? null, machineId, session);
  if (!settings.chatGroups || group === null || !groups?.answer) return null;
  return <TrailBar group={group} machineId={machineId} session={session} chats={chats} />;
}

function TrailBar({ group, machineId, session, chats }: { group: NonNullable<ReturnType<typeof groupOf>>; machineId: string; session: string; chats: readonly HostChatRow[] | undefined }) {
  const t = useT();
  const { settings } = useSettings();
  const machineIds = useMemo(() => [machineId], [machineId]);
  const feed = useCostsFeed(machineIds, settings.trackCosts);
  const rows = useMemo(() => new Map((chats ?? []).map((row) => [chatKey(machineId, row.session), row])), [chats, machineId]);
  const { states } = useMemberStates(group, rows, feed);
  const shown = [...states.values()];
  const count = group.members.length;
  return <nav className="group-trail" aria-label={t("Group {name}", { name: group.name })}>
    <button type="button" className="group-trail-open" onClick={() => groupsView.openGroup(group.id, { pc: machineId, session })}>
      <GalleryVerticalEnd className="group-trail-icon" aria-hidden="true" />
      <span className="group-trail-name" title={group.name}>{trailName(group.name)}</span>
      <span className="group-trail-facts">
        <span className="group-trail-dot" aria-hidden="true">·</span>
        <span>{t(count === 1 ? "1 chat" : "{n} chats", { n: count })}</span>
        {hasGroupState(shown) && <><span className="group-trail-dot" aria-hidden="true">·</span><GroupStateSummary states={shown} /></>}
      </span>
      <ChevronRight className="group-trail-chev" aria-hidden="true" />
    </button>
  </nav>;
}
