/**
 * Chat groups (ZAC-265), "Add to group"'s picks: the groups a chat most likely belongs in, at most
 * three, each with why (owner, round 8): first a ticket key the chat's title shares with the
 * group's name or a member's title (ZAC-265, SPK-45; any case, and whole: ZAC-26 is not ZAC-265),
 * then the same folder as the chat, then the most recently active. Also the search over a group's
 * name and its chats' titles. Pure: the sheet passes the rows.
 */
import type { ChatGroup } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { chatKey } from "./groups.ts";

/** How many groups are suggested. */
export const SUGGESTED = 3;

/** The ticket keys in a text, upper-cased: a letter-led project key, a dash, the number, each whole. */
export function ticketKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})(?![0-9])/g)) keys.add(`${match[1]!.toUpperCase()}-${match[2]}`);
  return keys;
}

export type SuggestReason = { kind: "ticket"; key: string } | { kind: "folder"; folder: string } | { kind: "recent"; at: number };

export interface GroupFacts {
  group: ChatGroup;
  /** the folder most of its chats are in (GroupsSheet.tsx groupFolder) */
  folder: string | null;
  /** when it last moved (GroupsSheet.tsx groupActive) */
  active: number;
}

/** The words a group is searched and ticket-matched by: its name, then its chats' titles. */
export function groupTexts(group: ChatGroup, rows: ReadonlyMap<string, HostChatRow>): string[] {
  return [group.name, ...group.members.map((member) => rows.get(chatKey(member.pc, member.session))?.title ?? "")].filter(Boolean);
}

/**
 * At most SUGGESTED groups for a chat, best first, each with its reason: a shared ticket key beats
 * the same folder, which beats recency; within a rank, the most recently active first. The group the
 * chat is already in is not suggested.
 */
export function suggestGroups(chat: { title: string; folder: string | null }, groups: readonly GroupFacts[], rows: ReadonlyMap<string, HostChatRow>,
  exclude: number | null = null): { facts: GroupFacts; reason: SuggestReason }[] {
  const mine = ticketKeys(chat.title);
  const ranked = groups.filter((each) => each.group.id !== exclude).map((facts) => {
    const theirs = mine.size === 0 ? new Set<string>() : ticketKeys(groupTexts(facts.group, rows).join("\n"));
    const key = [...mine].find((each) => theirs.has(each));
    const reason: SuggestReason = key !== undefined ? { kind: "ticket", key }
      : chat.folder !== null && facts.folder === chat.folder ? { kind: "folder", folder: chat.folder }
        : { kind: "recent", at: facts.active };
    const rank = reason.kind === "ticket" ? 0 : reason.kind === "folder" ? 1 : 2;
    return { facts, reason, rank };
  });
  ranked.sort((a, b) => a.rank - b.rank || b.facts.active - a.facts.active);
  return ranked.slice(0, SUGGESTED).map(({ facts, reason }) => ({ facts, reason }));
}

/** Whether a group answers a search: every word of it in its name or one of its chats' titles. */
export function groupMatches(group: ChatGroup, rows: ReadonlyMap<string, HostChatRow>, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = groupTexts(group, rows).join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}
