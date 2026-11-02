/**
 * Chat groups (ZAC-265): chats that hand off to each other, kept together with a digest. The
 * server files them (server/groups-store.ts) from the bridges' hand-off links; types only, so
 * the client can import them.
 */
import type { HostArtifact, HostLink } from "./host-chats.ts";

/** One chat in a group, known as (PC id, host session id); `link` was filed by a hand-off, `manual` placed by hand. */
export interface GroupMember { pc: string; session: string; joined: "link" | "manual"; addedAt: string }

export interface ChatGroup { id: number; name: string; createdAt: string; updatedAt: string; members: GroupMember[] }

/**
 * One line of a digest. Its link is only ever a real artifact from a member chat's own list (spec §3:
 * "links come from the chats' own artifact lists, not from the model's text"), so none is invented;
 * an item without one is an unfinished thread, drawn without a link.
 */
export interface DigestItem { text: string; artifact?: HostArtifact }

export type DigestEffort = "low" | "medium" | "high";

/** A group's digest (spec §3 "The digest's shape"): Direction, Open, Done, Per chat, and what wrote it. */
export interface GroupDigest {
  groupId: number;
  /** 3–4 lines on where the group is going */
  direction: string;
  open: DigestItem[];
  done: DigestItem[];
  /** one line per chat, newest first */
  perChat: { pc: string; session: string; line: string }[];
  /** the model id as OmniRoute routes it (opencode-go-claude-haiku-5-5) */
  model: string;
  effort: DigestEffort;
  /** what this digest's calls cost, chat summaries included */
  costUsd: number;
  writtenAt: string;
  /** the chats (`pc session`) it was written from: a member not among them joined since, one among them not a member left */
  chatsSeen: string[];
}

/** What a refresh would cost before it runs (the Refresh sheet's line); `usd` null when the model has no price. */
export interface DigestEstimate { chats: number; groupPasses: number; tokensIn: number; usd: number | null }

/**
 * A group's digest as GET /api/groups answers it, for the Groups cards: what wrote it, its first two
 * lines of Direction, how many chats moved on since (spec §3 Honesty, counted by the server from each
 * PC's `lastCallAt` and the members it saw), and what all its digests have cost. The page reads the
 * whole digest from GET /api/groups/<id>/digest.
 */
export interface GroupDigestMeta {
  groupId: number; writtenAt: string; costUsd: number; model: string; effort: DigestEffort;
  /** Direction's first two lines */
  direction: string;
  staleCount: number;
  /** every digest and chat summary call this group has made, failed runs' too */
  spentUsd: number;
  /** some call's model had no price: `spentUsd` is a floor */
  spendIncomplete: boolean;
}

/** GET /api/groups/<id>/digest: the digest, the refresh running (its stage), and the last refresh's failure. */
export interface GroupDigestAnswer {
  digest: GroupDigest | null;
  writing?: { phase: "summaries" | "group"; done: number; total: number };
  error?: DigestFailure;
  spentUsd: number;
  spendIncomplete: boolean;
}

/** A refresh in progress: the chats' summaries first, then the group pass. */
export type DigestProgress = { stage: "summaries"; done: number; total: number } | { stage: "digest" };

/** A refresh that failed: the old digest stays, this under its header. */
export interface DigestFailure { source: string; message: string; at: string }

/** About five lines on one chat, cached until the chat has a newer call. */
export interface ChatSummary { pc: string; session: string; text: string; lastCallSeen: string | null; model: string; writtenAt: string }

export interface GroupsAnswer {
  groups: ChatGroup[];
  links: (HostLink & { pc: string })[];
  summaries: ChatSummary[];
  digests: GroupDigestMeta[];
  digestDefaults: { model: string; effort: string };
}
