/**
 * Chat groups (ZAC-265), the trail in a chat that is in a group (owner's option C): one thin line
 * under the header, "⧉ Ovis keep-warm · 262 → 265 [Group]". The steps are the hand-offs that led
 * here (lib/groups.ts trailTo), each a tap to that chat, this one strong; the group's name and the
 * Group badge open the group's page. Nothing at all while Settings → Chat groups is off or the chat
 * is in no group. A long trail keeps its first step and its last two, "…" between.
 */
import { Fragment } from "react";
import { ArrowRight, Layers } from "lucide-react";

import "./GroupTrail.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { groupOf, groupsView, shortChatName, trailTo, useGroups } from "../lib/groups.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";

export function GroupTrail({ machineId, session, title, chats, onOpenChat }: {
  machineId: string; session: string;
  /** this chat's title, before its PC's list has it */
  title: string;
  /** the PC's chats, for the other steps' names */
  chats: readonly HostChatRow[] | undefined;
  onOpenChat?(session: string): void;
}) {
  const t = useT();
  const { settings } = useSettings();
  const groups = useGroups(settings.chatGroups);
  const group = groupOf(groups?.answer ?? null, machineId, session);
  if (!settings.chatGroups || group === null || !groups?.answer) return null;
  const path = trailTo(group, groups.answer.links, session, machineId);
  const name = (step: string): string => shortChatName(step === session ? title : chats?.find((row) => row.session === step)?.title.trim() || t("Copilot chat"));
  const shown: (string | null)[] = path.length > 3 ? [path[0]!, null, ...path.slice(-2)] : path;
  const openPage = (): void => groupsView.openGroup(group.id);
  return <nav className="group-trail" aria-label={t("Group {name}", { name: group.name })}>
    <Layers className="group-trail-icon" aria-hidden="true" />
    <button type="button" className="group-trail-name" onClick={openPage}>{group.name}</button>
    <span className="group-trail-dot" aria-hidden="true">·</span>
    {shown.map((step, index) => <Fragment key={step ?? `gap-${index}`}>
      {index > 0 && <ArrowRight className="group-trail-arrow" aria-hidden="true" />}
      {step === null ? <span className="group-trail-gap">…</span>
        : step === session ? <span className="group-trail-step is-current" aria-current="page">{name(step)}</span>
          : <button type="button" className="group-trail-step" onClick={() => onOpenChat?.(step)}>{name(step)}</button>}
    </Fragment>)}
    <button type="button" className="badge group-trail-badge" onClick={openPage}>{t("Group")}</button>
  </nav>;
}
