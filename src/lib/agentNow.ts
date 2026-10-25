/**
 * What an Agents row says it is doing now, after its place (owner, 2026-10-25): the wait when it
 * needs you, else its plan's step and progress. Only what the pane already carries: no transcript read.
 */
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Translate } from "./i18n.ts";

export interface AgentNow { text: string; tone: "ask" | "plain" }

export function agentNow(pane: Pick<HerdrPane, "plan">, status: AgentStatus | undefined, t: Translate): AgentNow | null {
  if (status === "blocked") return { text: t("Waiting for you"), tone: "ask" };
  const plan = pane.plan;
  if (!plan || plan.total === 0) return null;
  const progress = `${plan.done}/${plan.total}`;
  return { text: plan.current ? `${plan.current} · ${progress}` : progress, tone: "plain" };
}

/** A host chat's line: the wait when it asks, else the host's own word for what it does (its intent, a command's progress). */
export function hostChatNow(chat: Pick<HostChatRow, "status" | "activity">, t: Translate): AgentNow | null {
  if (chat.status === "asks") return { text: t("Waiting for you"), tone: "ask" };
  return chat.activity ? { text: chat.activity, tone: "plain" } : null;
}

/** The Agents list's groups: needs you, working, an unread finish, the rest. */
export function attentionRank(status: AgentStatus | undefined): number {
  return status === "blocked" ? 0 : status === "working" ? 1 : status === "done" ? 2 : 3;
}
