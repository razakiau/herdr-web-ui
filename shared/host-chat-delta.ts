/**
 * A chat read that moves only what changed (ZAC-340): a newest read of host-chats/chat names the
 * prefix of its turns the next read may skip (`base`: how many turns, and a digest of them), and
 * the digest of its `commands`. The client echoes them (`known`, `commands`); a server whose own
 * turns hash the same answers only the turns after that prefix (`delta`), and leaves out commands
 * that did not change (`commands_same`). The digest is the server's alone (the bridge, or CT 208's
 * proxy for an older bridge): the client never computes one, it rebuilds the full read here.
 */
import type { HostChatRead } from "./host-chats.ts";

/**
 * A read's turns `[from, n)` (from 0 when absent) by the digest of `JSON.stringify(turns.slice(from, n))`.
 * A range that starts past 0 (a tail read, ZAC-340 part 2) names its first host turn by id
 * (`anchor`): the server finds it again however its window moved since.
 */
export interface HostChatBase { n: number; hash: string; from?: number; anchor?: string }

/** The query parameters a newest read sends back. */
export const KNOWN_PARAM = "known";
export const COMMANDS_PARAM = "commands";
export const ANCHOR_PARAM = "anchor";
/** A device with nothing kept asks for the chat's last turns only (`tail=1`): older ones are paged in. */
export const TAIL_PARAM = "tail";
/** The turns before the host turn of this id, a page at a time (`page_before=<id>`): a HostChatPage. */
export const PAGE_PARAM = "page_before";
/** A tail, and each page, holds this many host turns at most… */
export const TAIL_HOST_TURNS = 10;
/** …and a tail's turns this many characters serialized at most, older turns going first, one host turn at least… */
export const TAIL_MAX_CHARS = 150 * 1024;
/** …and a page's this many: a scroll up waits on the line anyway, and fewer pages mean fewer waits. */
export const PAGE_MAX_CHARS = 600 * 1024;

/**
 * Turns before a host turn of the window, read from the bridge one page at a time (`page_before`):
 * `turns` are the window's turns `[offset, offset + turns.length)`, and `cursor` the host's own,
 * for the turns before the window once `offset` is 0.
 */
export interface HostChatPage {
  session: string; page: true; turns: HostChatRead["turns"]; offset: number; cursor: string | null;
  /** the page's host turns' ids, in order */
  message_ids: string[];
}

/**
 * Where a tail (or a page ending at `end`, with `max` PAGE_MAX_CHARS) starts: the last
 * TAIL_HOST_TURNS host turns before `end`, fewer while they weigh over `max` characters
 * serialized, never less than one host turn.
 */
export function tailStart(turns: readonly unknown[], end = turns.length, max = TAIL_MAX_CHARS): number {
  const size = (turn: unknown): number => JSON.stringify(turn).length;
  let start = Math.max(0, end - 2 * TAIL_HOST_TURNS);
  start -= start % 2;
  const sizes = turns.slice(start, end).map(size);
  let total = sizes.reduce((sum, each) => sum + each, 0);
  while (start < end - 2 && total > max) {
    total -= sizes.shift()! + (sizes.shift() ?? 0);
    start += 2;
  }
  return start;
}

/**
 * How many turns a read's `base` covers: every turn when the chat is idle; while it is busy, all
 * but the last host turn (a user turn and its assistant turn), which is still changing. Even, so a
 * host turn's two halves are never split.
 */
export function baseTurns(turns: number, busy: boolean): number {
  const n = busy ? Math.max(0, turns - 2) : turns;
  return n - (n % 2);
}

/** `known`'s spelling: `<n>.<hash>` from the window's start, `<from>.<n>.<hash>` past it (with `anchor`). */
export const knownParam = (base: HostChatBase): string => (base.from ?? 0) > 0 ? `${base.from}.${base.n}.${base.hash}` : `${base.n}.${base.hash}`;

/** The query a newest read sends its base back with. */
export function knownQuery(base: HostChatBase): Record<string, string> {
  return { [KNOWN_PARAM]: knownParam(base), ...((base.from ?? 0) > 0 && base.anchor !== undefined ? { [ANCHOR_PARAM]: base.anchor } : {}) };
}

/** A `known` the client sent, or null when it is absent or not one (a full read, no error). */
export function parseKnown(value: string | null): HostChatBase | null {
  const match = /^(?:(\d{1,7})\.)?(\d{1,7})\.([A-Za-z0-9_-]{8,64})$/.exec(value ?? "");
  if (!match) return null;
  const from = match[1] === undefined ? 0 : Number(match[1]);
  const n = Number(match[2]);
  if (n < from) return null;
  return from > 0 ? { from, n, hash: match[3]! } : { n, hash: match[3]! };
}

/**
 * The full read a delta stands for, from the read the client held when it asked; null when the
 * two cannot be joined (a delta from past what is held, commands left out that were never held,
 * a window that moved under what is held): the caller drops what it holds and reads again. A read
 * that is no delta is handed back as it is.
 *
 * A held read may start past the window's start (`offset`, a tail and the pages read before it).
 * Its base then names its first host turn (`anchor`), and the server says where that turn is now
 * (`anchor_at`): the held turns move with it.
 */
export function applyDelta(prev: HostChatRead | null, next: HostChatRead): HostChatRead | null {
  const { delta, commands_same: same, anchor_at: anchorAt, ...rest } = next;
  // a first open's tail without its commands: none held yet (the next read brings them)
  if (next.commands_deferred === true && next.commands === undefined) return applyDelta(prev, { ...next, commands: [] });
  if (delta === undefined && same === undefined) return next;
  let turns = next.turns;
  let offset = 0;
  if (delta !== undefined) {
    if (prev === null || !Number.isInteger(delta.from) || delta.from < 0) return null;
    const shift = anchorAt === undefined ? 0 : anchorAt - (prev.base?.from ?? 0);
    offset = (prev.offset ?? 0) + shift;
    const local = delta.from - offset;
    if (offset < 0 || local < 0 || local > prev.turns.length) return null;
    turns = [...prev.turns.slice(0, local), ...next.turns];
  }
  let commands = next.commands;
  if (same === true) {
    if (prev === null || !Array.isArray(prev.commands)) return null;
    commands = prev.commands;
  }
  const { offset: _offset, ...body } = rest;
  return offset > 0 ? { ...body, turns, commands, offset } : { ...body, turns, commands };
}

/**
 * A held read with a page of older turns put before it: the page ends where the held turns start.
 * Null when it does not, or when the window moved since the read (its ids no longer line up with
 * the window's: the next read realigns them).
 */
export function prependPage(held: HostChatRead, page: HostChatPage): HostChatRead | null {
  const offset = held.offset ?? 0;
  if (offset === 0 || page.turns.length === 0 || page.turns.length % 2 !== 0 || page.offset + page.turns.length !== offset) return null;
  if (held.message_ids.slice(page.offset / 2, offset / 2).join("\n") !== page.message_ids.join("\n")) return null;
  const { offset: _offset, ...body } = held;
  const turns = [...page.turns, ...held.turns];
  return page.offset > 0 ? { ...body, turns, offset: page.offset } : { ...body, turns };
}
