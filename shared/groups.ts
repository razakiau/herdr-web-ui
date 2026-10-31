/**
 * Chat groups (ZAC-265): chats that hand off to each other, kept together with a digest. The
 * server files them (server/groups-store.ts) from the bridges' hand-off links; types only, so
 * the client can import them.
 */
import type { HostLink } from "./host-chats.ts";

/** One chat in a group, known as (PC id, host session id); `link` was filed by a hand-off, `manual` placed by hand. */
export interface GroupMember { pc: string; session: string; joined: "link" | "manual"; addedAt: string }

export interface ChatGroup { id: number; name: string; createdAt: string; updatedAt: string; members: GroupMember[] }

/** One line of a digest, optionally pointing at an artifact or the chat it came from. */
export interface DigestItem { text: string; artifactId?: string; session?: string }

export interface GroupDigest {
  groupId: number;
  direction: string;
  open: DigestItem[];
  done: DigestItem[];
  perChat: { pc: string; session: string; line: string }[];
  model: string;
  effort: string;
  cost: number | null;
  writtenAt: string;
  /** `pc session` → the chat's `lastCallAt` the digest saw */
  chatsSeen: Record<string, string>;
}

/** About five lines on one chat, cached until the chat has a newer call. */
export interface ChatSummary { pc: string; session: string; text: string; lastCallSeen: string | null; model: string; writtenAt: string }

export interface GroupsAnswer {
  groups: ChatGroup[];
  links: (HostLink & { pc: string })[];
  summaries: ChatSummary[];
  digests: GroupDigest[];
  digestDefaults: { model: string; effort: string };
}
