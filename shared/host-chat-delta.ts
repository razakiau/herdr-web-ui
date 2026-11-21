/**
 * A chat read that moves only what changed (ZAC-340): a newest read of host-chats/chat names the
 * prefix of its turns the next read may skip (`base`: how many turns, and a digest of them), and
 * the digest of its `commands`. The client echoes them (`known`, `commands`); a server whose own
 * turns hash the same answers only the turns after that prefix (`delta`), and leaves out commands
 * that did not change (`commands_same`). The digest is the server's alone (the bridge, or CT 208's
 * proxy for an older bridge): the client never computes one, it rebuilds the full read here.
 */
import type { HostChatRead } from "./host-chats.ts";

/** The first `n` turns of a read, by the digest of `JSON.stringify(turns.slice(0, n))`. */
export interface HostChatBase { n: number; hash: string }

/** The query parameters a newest read sends back. */
export const KNOWN_PARAM = "known";
export const COMMANDS_PARAM = "commands";

/**
 * How many turns a read's `base` covers: every turn when the chat is idle; while it is busy, all
 * but the last host turn (a user turn and its assistant turn), which is still changing. Even, so a
 * host turn's two halves are never split.
 */
export function baseTurns(turns: number, busy: boolean): number {
  const n = busy ? Math.max(0, turns - 2) : turns;
  return n - (n % 2);
}

/** `known`'s spelling: `<n>.<hash>`. */
export const knownParam = (base: HostChatBase): string => `${base.n}.${base.hash}`;

/** A `known` the client sent, or null when it is absent or not one (a full read, no error). */
export function parseKnown(value: string | null): HostChatBase | null {
  const match = /^(\d{1,7})\.([A-Za-z0-9_-]{8,64})$/.exec(value ?? "");
  if (!match) return null;
  return { n: Number(match[1]), hash: match[2]! };
}

/**
 * The full read a delta stands for, from the full read the client held when it asked; null when
 * the two cannot be joined (a delta from past what is held, commands left out that were never
 * held): the caller drops what it holds and reads again in full. A read that is no delta is handed
 * back as it is.
 */
export function applyDelta(prev: HostChatRead | null, next: HostChatRead): HostChatRead | null {
  const { delta, commands_same: same, ...rest } = next;
  if (delta === undefined && same === undefined) return next;
  let turns = next.turns;
  if (delta !== undefined) {
    if (prev === null || !Number.isInteger(delta.from) || delta.from < 0 || delta.from > prev.turns.length) return null;
    turns = [...prev.turns.slice(0, delta.from), ...next.turns];
  }
  let commands = next.commands;
  if (same === true) {
    if (prev === null || !Array.isArray(prev.commands)) return null;
    commands = prev.commands;
  }
  return { ...rest, turns, commands };
}
