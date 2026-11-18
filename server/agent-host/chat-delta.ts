/**
 * The server's half of a chat read that moves only what changed (ZAC-340, shared/host-chat-delta.ts):
 * the bridge's GET host-chats/chat, and CT 208's proxy for a bridge before it, hash the read's own
 * turns and answer a `known` prefix that hashes the same with only the turns after it.
 */
import { createHash, type Hash } from "node:crypto";
import type { HostChatRead } from "../../shared/host-chats.ts";
import { baseTurns, COMMANDS_PARAM, KNOWN_PARAM, parseKnown } from "../../shared/host-chat-delta.ts";

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

/**
 * A newest read as it goes out: with its `base` and `commands_hash`, and, when the client's
 * `known` prefix hashes as this read's own first turns do, only the turns after it (`delta`);
 * commands the client's `commands` digest names are left out (`commands_same`). A `known` that
 * does not match, or is no `known`, gets the whole read: never an error.
 */
export function deltaRead(read: HostChatRead, query: URLSearchParams): HostChatRead {
  const { delta: _delta, commands_same: _same, base: _base, commands_hash: _commandsHash, ...full } = read;
  const n = baseTurns(full.turns.length, full.busy);
  const known = parseKnown(query.get(KNOWN_PARAM));
  const usable = known !== null && known.n <= full.turns.length ? known : null;
  const hashes = prefixHashes(full.turns, usable === null ? [n] : [n, usable.n]);
  const commands_hash = commandsHash(full.commands);
  const out: HostChatRead = { ...full, base: { n, hash: hashes.get(n)! }, commands_hash };
  if (usable !== null && hashes.get(usable.n) === usable.hash) {
    out.turns = full.turns.slice(usable.n);
    out.delta = { from: usable.n };
  }
  if (query.get(COMMANDS_PARAM) === commands_hash) {
    delete (out as Partial<HostChatRead>).commands;
    out.commands_same = true;
  }
  return out;
}

/** The header a bridge's newest read carries once it adds `base` itself: CT 208's proxy then passes it on as it is. */
export const DELTA_HEADER = "x-ovis-chat-base";
