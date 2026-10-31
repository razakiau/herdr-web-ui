/**
 * Chat groups on the page (ZAC-265): the server's groups (GET /api/groups, shared/groups.ts), read
 * while something on screen wants them, and again on each `groups` nudge of the app's event stream
 * (lib/useMachineRoster.ts hands it here: the nudge carries nothing) and whenever the stream reopens
 * or the page comes back (lib/hostChats.ts onHostChatResume): a nudge missed meanwhile is caught up.
 * Then the pure parts the screens draw from: the hand-off order of a group's chats (the group page),
 * the path to one chat (its trail bar), and the artifacts of every chat without duplicates. And the
 * one store saying which group view is open (App.tsx draws it: GroupsHost).
 */
import { useEffect, useSyncExternalStore } from "react";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostArtifact, HostChatRow, HostLink, LinkKind } from "../../shared/host-chats.ts";
import { getJson } from "./api.ts";
import { onHostChatResume } from "./hostChats.ts";
import type { CostsFeed } from "./rowCache.ts";
import { addSplit, costSplit, emptySplit, type CostSplit } from "./sessionCost.ts";

/** A chat across PCs, as the server's `chatsSeen` names it: `pc session`. */
export const chatKey = (pc: string, session: string): string => `${pc} ${session}`;

type GroupLink = HostLink & { pc: string };

/** One chat of a group in hand-off order: how it joined (null: the first of its chain), and the chat its source also handed off to before it. */
export interface ChainStep {
  session: string;
  pc: string;
  join: { kind: LinkKind | "manual"; from?: string } | null;
  /** the source's session when it handed off to another chat first: "262 also handed off" */
  forkNote?: string;
}

const timeOf = (row: HostChatRow | undefined): number => {
  const at = row ? Date.parse(row.modified_at) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/** The links between two members of the group on the same PC, oldest first. */
function inGroup(group: ChatGroup, links: readonly GroupLink[]): GroupLink[] {
  const members = new Set(group.members.map((member) => chatKey(member.pc, member.session)));
  return links.filter((link) => link.from !== link.to && members.has(chatKey(link.pc, link.from)) && members.has(chatKey(link.pc, link.to)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The group's chats in hand-off order (the group page's timeline): each chain from its first chat,
 * following the links oldest first (a chat whose source handed off to another one before it says
 * so in `forkNote`); a chat in no link of the group (added by hand) stands alone. Chains and lone
 * chats are placed by when they last changed (`rows`, keyed by chatKey; a chain by its earliest),
 * a chat no list has (gone, its PC offline) last among them. Every member is in it once, loops too.
 */
export function chainOrder(group: ChatGroup, links: readonly GroupLink[], rows: ReadonlyMap<string, HostChatRow>): ChainStep[] {
  const own = inGroup(group, links);
  const children = new Map<string, GroupLink[]>();
  const parents = new Set<string>();
  for (const link of own) {
    const from = chatKey(link.pc, link.from);
    children.set(from, [...children.get(from) ?? [], link]);
    parents.add(chatKey(link.pc, link.to));
  }
  const linked = new Set(own.flatMap((link) => [chatKey(link.pc, link.from), chatKey(link.pc, link.to)]));
  const byKey = new Map(group.members.map((member) => [chatKey(member.pc, member.session), member]));
  const seen = new Set<string>();
  const walk = (key: string, join: ChainStep["join"], forkNote: string | undefined, out: ChainStep[]): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const member = byKey.get(key)!;
    out.push({ session: member.session, pc: member.pc, join, ...(forkNote !== undefined ? { forkNote } : {}) });
    let earlier = 0;
    for (const link of children.get(key) ?? []) {
      const next = chatKey(link.pc, link.to);
      if (seen.has(next)) continue;
      walk(next, { kind: link.kind, from: link.from }, earlier > 0 ? link.from : undefined, out);
      earlier += 1;
    }
  };
  const blocks: { at: number; steps: ChainStep[] }[] = [];
  // a chain's first chat: linked, and no link of the group leads to it; then whatever a loop left
  const starts = [...group.members.map((member) => chatKey(member.pc, member.session)).filter((key) => linked.has(key) && !parents.has(key)),
    ...[...linked].sort((a, b) => timeOf(rows.get(a)) - timeOf(rows.get(b)))];
  for (const key of starts) {
    if (seen.has(key)) continue;
    const steps: ChainStep[] = [];
    walk(key, null, undefined, steps);
    blocks.push({ at: Math.min(...steps.map((step) => timeOf(rows.get(chatKey(step.pc, step.session))))), steps });
  }
  for (const member of group.members) {
    const key = chatKey(member.pc, member.session);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ at: timeOf(rows.get(key)), steps: [{ session: member.session, pc: member.pc, join: member.joined === "manual" ? { kind: "manual" } : null }] });
  }
  // a stable sort: chats of equal time keep the members' order
  return blocks.map((block, index) => ({ ...block, index })).sort((a, b) => a.at - b.at || a.index - b.index).flatMap((block) => block.steps);
}

/**
 * The trail bar's path (C): from the first chat of this one's chain to it, following the links back
 * (the oldest link into each chat). Where the trail forks only this branch is in it; a chat in no
 * link of the group is a trail of one.
 */
export function trailTo(group: ChatGroup, links: readonly GroupLink[], session: string, pc?: string): string[] {
  const member = group.members.find((each) => each.session === session && (pc === undefined || each.pc === pc));
  if (!member) return [session];
  const own = inGroup(group, links).filter((link) => link.pc === member.pc);
  const path = [session];
  const seen = new Set(path);
  for (let at = session; ;) {
    const back = own.find((link) => link.to === at);
    if (!back || seen.has(back.from)) break;
    path.unshift(back.from);
    seen.add(back.from);
    at = back.from;
  }
  return path;
}

/**
 * The artifacts of every chat (keyed by chatKey), each once: the same PR made in two chats shows
 * once, with both chats in `from`. Keyed by what names it (`link ?? uri ?? commitHash ?? id`), in
 * the order first met.
 */
export function dedupArtifacts(perChat: ReadonlyMap<string, readonly HostArtifact[]>): { artifact: HostArtifact; from: string[] }[] {
  const found = new Map<string, { artifact: HostArtifact; from: string[] }>();
  for (const [chat, artifacts] of perChat) {
    for (const artifact of artifacts) {
      const key = artifact.link ?? artifact.uri ?? artifact.commitHash ?? artifact.id;
      const entry = found.get(key);
      if (!entry) found.set(key, { artifact, from: [chat] });
      else if (!entry.from.includes(chat)) entry.from.push(chat);
    }
  }
  return [...found.values()];
}

/** A chat as a trail step says it: a ticket's number ("ZAC-265 Ovis groups" → 265), else its first two words. */
export function shortChatName(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "…";
  const ticket = /^[A-Za-z][A-Za-z0-9]*-(\d+)$/.exec(words[0]!.replace(/[:,.]$/, ""));
  if (ticket) return ticket[1]!;
  return words.length > 2 ? `${words.slice(0, 2).join(" ")}…` : words.join(" ");
}

/** The group a chat is in, if any. */
export function groupOf(answer: GroupsAnswer | null, pc: string, session: string): ChatGroup | null {
  return answer?.groups.find((group) => group.members.some((member) => member.pc === pc && member.session === session)) ?? null;
}

// ─── The feed ────────────────────────────────────────────────────────────────

const nudgeListeners = new Set<() => void>();

/** The app's event stream said the groups changed (lib/useMachineRoster.ts). */
export function noteGroupsChanged(): void {
  for (const listener of [...nudgeListeners]) listener();
}

export function onGroupsChanged(listener: () => void): () => void {
  nudgeListeners.add(listener);
  return () => { nudgeListeners.delete(listener); };
}

/** The groups as last read (null before the first answer); `failed`: the last read did not answer. */
export interface GroupsState { answer: GroupsAnswer | null; failed: boolean }

export function createGroupsFeed({ fetch, onNudge, onResume }: {
  fetch: () => Promise<GroupsAnswer>;
  onNudge: (listener: () => void) => () => void;
  onResume: (listener: () => void) => () => void;
}) {
  let state: GroupsState = { answer: null, failed: false };
  const listeners = new Set<() => void>();
  const set = (next: GroupsState): void => { state = next; for (const listener of [...listeners]) listener(); };
  let wanted = 0;
  let flying = false;
  let again = false;
  let stops: (() => void)[] = [];
  /** one read at a time; a nudge during one reads once more after it */
  const load = (): void => {
    if (flying) { again = true; return; }
    flying = true;
    void fetch().then((answer) => set({ answer, failed: false }), () => set({ ...state, failed: true })).finally(() => {
      flying = false;
      if (again && wanted > 0) { again = false; load(); }
    });
  };
  return {
    read: (): GroupsState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** read now (after a change made here: the nudge follows, but the page need not wait for it) */
    refresh: load,
    /** a screen that shows groups: read on the first, listen while any is up */
    want(): () => void {
      wanted += 1;
      if (wanted === 1) {
        stops = [onNudge(load), onResume(load)];
        load();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        wanted -= 1;
        if (wanted === 0) { for (const stop of stops) stop(); stops = []; again = false; }
      };
    },
    /** for tests: nothing read */
    reset(): void { state = { answer: null, failed: false }; again = false; },
  };
}

export const groupsFeed = createGroupsFeed({
  fetch: () => getJson<GroupsAnswer>("/api/groups", { cache: "no-store" }),
  onNudge: onGroupsChanged,
  onResume: onHostChatResume,
});

/** The groups while `on` (Settings → Chat groups): null while off. */
export function useGroups(on: boolean): GroupsState | null {
  useEffect(() => (on ? groupsFeed.want() : undefined), [on]);
  const state = useSyncExternalStore(groupsFeed.subscribe, groupsFeed.read, groupsFeed.read);
  return on ? state : null;
}

// ─── Changes ─────────────────────────────────────────────────────────────────

async function change<T>(path: string, body: unknown): Promise<T> {
  const answer = await getJson<T>(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  groupsFeed.refresh();
  return answer;
}

export interface ChatRef { pc: string; session: string }

export const groupsApi = {
  create: (name: string, first?: ChatRef) => change<{ id: number }>("/api/groups", first ? { name, first } : { name }),
  rename: (id: number, name: string) => change<{ ok: true }>(`/api/groups/${id}/rename`, { name }),
  remove: (id: number) => change<{ ok: true }>(`/api/groups/${id}/delete`, {}),
  /** puts the chat in the group, moving it out of the one it was in */
  add: (id: number, chat: ChatRef) => change<{ ok: true }>(`/api/groups/${id}/add`, chat),
  ungroup: (chat: ChatRef) => change<{ ok: true }>("/api/groups/remove", chat),
  /** the chat and the ones linked after it start a new group */
  split: (chat: ChatRef) => change<{ id: number }>("/api/groups/split", chat),
};

// ─── Which view is open ──────────────────────────────────────────────────────

/** The Groups sheet (B), one group's page (E), the "Add to group" sheet for a chat; App draws them (GroupsHost). */
export interface GroupsView { list: boolean; group: number | null; addTo: ChatRef | null }

function createGroupsView() {
  let state: GroupsView = { list: false, group: null, addTo: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<GroupsView>): void => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };
  return {
    read: (): GroupsView => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    openList: (): void => set({ list: true }),
    closeList: (): void => set({ list: false }),
    /** a group's page, over the list when that is open: closing it goes back to the list */
    openGroup: (group: number): void => set({ group }),
    closeGroup: (): void => set({ group: null }),
    openAddTo: (chat: ChatRef): void => set({ addTo: chat }),
    closeAddTo: (): void => set({ addTo: null }),
    /** a chat opened from a view: every one of them goes */
    closeAll: (): void => set({ list: false, group: null, addTo: null }),
  };
}

export const groupsView = createGroupsView();

export function useGroupsView(): GroupsView {
  return useSyncExternalStore(groupsView.subscribe, groupsView.read, groupsView.read);
}

// ─── Costs ───────────────────────────────────────────────────────────────────

/**
 * Each chat's cost by chatKey from the page's costs feed (lib/rowCache.ts), as All agents prices a
 * row: its split at list price, a floor while a log is partly read. Empty without prices.
 */
export function chatCosts(feed: CostsFeed | null): Map<string, CostSplit> {
  const costs = new Map<string, CostSplit>();
  const prices = feed?.prices;
  if (!feed || !prices || (prices.prices === null && prices.fallback === null)) return costs;
  for (const [pc, answer] of feed.answers) {
    if (!answer) continue;
    for (const chat of answer.chats) {
      const split = costSplit(chat.models, prices.prices ?? {}, prices.fallback);
      costs.set(chatKey(pc, chat.session), { ...split, floor: split.floor || chat.partial || !answer.complete });
    }
  }
  return costs;
}

/** What the chats cost together; null when none of them has a cost. */
export function costOf(keys: readonly string[], costs: ReadonlyMap<string, CostSplit>): CostSplit | null {
  const total = emptySplit();
  let any = false;
  for (const key of keys) {
    const split = costs.get(key);
    if (!split) continue;
    addSplit(total, split);
    any = true;
  }
  return any ? total : null;
}
