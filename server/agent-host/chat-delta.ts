/**
 * The server's half of a chat read that moves only what changed (ZAC-340, shared/host-chat-delta.ts):
 * the bridge's GET host-chats/chat, and CT 208's proxy for a bridge before it, hash the read's own
 * turns and answer a `known` prefix that hashes the same with only the turns after it.
 */
import { createHash, type Hash } from "node:crypto";
import type { HostChatRead } from "../../shared/host-chats.ts";
import { ANCHOR_PARAM, baseTurns, COMMANDS_PARAM, KNOWN_PARAM, PAGE_MAX_CHARS, PAGE_PARAM, parseKnown, tailStart, TAIL_PARAM, type HostChatBase, type HostChatPage } from "../../shared/host-chat-delta.ts";

const digest = (hash: Hash): string => hash.digest("base64url").slice(0, 22);

/**
 * The digest of `JSON.stringify(turns.slice(0, n))` for each `n` asked, from one pass over the
 * turns: each turn is stringified once, and the hash is copied at each `n` and closed there.
 */
export function prefixHashes(turns: readonly unknown[], at: readonly number[]): Map<number, string> {
  const wanted = new Set(at.filter((n) => n >= 0 && n <= turns.length));
  const out = new Map<number, string>();
  const last = Math.max(-1, ...wanted);
  const hash = createHash("sha256");
  hash.update("[");
  for (let i = 0; i <= last; i++) {
    if (wanted.has(i)) out.set(i, digest(hash.copy().update("]")));
    if (i === turns.length) break;
    if (i > 0) hash.update(",");
    hash.update(JSON.stringify(turns[i]));
  }
  return out;
}

export const commandsHash = (commands: HostChatRead["commands"] | undefined): string =>
  digest(createHash("sha256").update(JSON.stringify(commands ?? null)));

const rangeHash = (turns: readonly unknown[], from: number, n: number): string =>
  digest(createHash("sha256").update(JSON.stringify(turns.slice(from, n))));

/** The window's turns `[from, n)` as a read's base; past the window's start it names its first host turn. */
function baseOf(read: HostChatRead, from: number, hashes?: Map<number, string>): HostChatBase {
  const n = Math.max(from, baseTurns(read.turns.length, read.busy));
  const hash = from === 0 ? hashes?.get(n) ?? prefixHashes(read.turns, [n]).get(n)! : rangeHash(read.turns, from, n);
  const anchor = from > 0 ? read.message_ids[from / 2] : undefined;
  return from > 0 && anchor !== undefined ? { from, n, hash, anchor } : { n, hash };
}

/** Thrown for a page whose first held turn the window no longer has: 409 history_changed. */
export class WindowMoved extends Error {}

/**
 * The page of turns before the host turn `id` (PAGE_PARAM): the last host turns before it, as many
 * as a tail holds. Throws WindowMoved when the window has no such turn.
 */
export function pageBefore(read: HostChatRead, id: string): HostChatPage {
  const at = read.message_ids.indexOf(id);
  if (at < 0 || 2 * at >= read.turns.length) throw new WindowMoved(`no turn ${id} in the chat's window`);
  const end = 2 * at;
  const start = tailStart(read.turns, end, PAGE_MAX_CHARS);
  return { session: read.session, page: true, turns: read.turns.slice(start, end), offset: start, cursor: read.cursor, message_ids: read.message_ids.slice(start / 2, end / 2) };
}

/**
 * A newest read as it goes out (ZAC-340): with its `base` and `commands_hash`, and, when the
 * client's `known` range hashes as this read's own turns there do, only the turns after it
 * (`delta`, with `anchor_at` for a range past the window's start, found again by its anchor's id);
 * commands the client's `commands` digest names are left out (`commands_same`). Without a match,
 * `tail` asks for the last turns only (`offset`); else the whole read. A `known` that does not
 * match, or is no `known`, is never an error. A page is chatAnswer's.
 */
export function deltaRead(read: HostChatRead, query: URLSearchParams): HostChatRead {
  const { delta: _delta, commands_same: _same, commands_deferred: _deferred, base: _base, commands_hash: _commandsHash, offset: _offset, anchor_at: _anchorAt, ...full } = read;
  const total = full.turns.length;
  const known = parseKnown(query.get(KNOWN_PARAM));
  let match: { from: number; n: number; ranged: boolean } | null = null;
  let hashes: Map<number, string> | undefined;
  if (known !== null && (known.from ?? 0) === 0) {
    if (known.n <= total) {
      hashes = prefixHashes(full.turns, [known.n, baseTurns(total, full.busy)]);
      if (hashes.get(known.n) === known.hash) match = { from: 0, n: known.n, ranged: false };
    }
  } else if (known !== null) {
    const at = full.message_ids.indexOf(query.get(ANCHOR_PARAM) ?? "");
    const from = 2 * at;
    const n = from + known.n - known.from!;
    if (at >= 0 && n <= total && rangeHash(full.turns, from, n) === known.hash) match = { from, n, ranged: true };
  }
  const commands_hash = commandsHash(full.commands);
  let out: HostChatRead;
  if (match !== null) {
    out = { ...full, turns: full.turns.slice(match.n), base: baseOf(full, match.from, hashes), commands_hash, delta: { from: match.n } };
    if (match.ranged) out.anchor_at = match.from;
  } else if (query.get(TAIL_PARAM) === "1") {
    const start = tailStart(full.turns);
    out = { ...full, turns: full.turns.slice(start), base: baseOf(full, start, hashes), commands_hash };
    if (start > 0) out.offset = start;
  } else {
    out = { ...full, base: baseOf(full, 0, hashes), commands_hash };
  }
  if (query.get(COMMANDS_PARAM) === commands_hash) {
    delete (out as Partial<HostChatRead>).commands;
    out.commands_same = true;
  } else if (known === null && query.get(TAIL_PARAM) === "1") {
    // a first open (nothing known): the "/" list waits for the next read, which knows the tail
    delete (out as Partial<HostChatRead>).commands;
    out.commands_deferred = true;
  }
  return out;
}

/** A newest read's answer: a page of older turns for `page_before` (WindowMoved when it cannot be), else deltaRead's. */
export function chatAnswer(read: HostChatRead, query: URLSearchParams): HostChatRead | HostChatPage {
  const page = query.get(PAGE_PARAM);
  return page === null ? deltaRead(read, query) : pageBefore(read, page);
}

/**
 * The header a bridge's newest read carries once it adds `base` itself, by what it does: "1"
 * (bundle 1104) deltas from the window's start; "2" (1105) also tails, ranges and pages. CT 208's
 * proxy passes a "2" answer on as it is, and makes the rest itself.
 */
export const DELTA_HEADER = "x-ovis-chat-base";
export const DELTA_LEVEL = "2";
