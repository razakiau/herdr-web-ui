/**
 * Each PC's VS Code chats, for the sidebar: the list its bridge reads from VS Code's agent host
 * (server/vscode), and the host's state. A PC whose bridge has the feature off (404 `vscode_off`)
 * has no group and is not asked again until the roster changes; the pushes (`vscode-host`,
 * `vscode-chat-changed`) that App.tsx hands to noteVscodeMessage refetch a PC's list.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Machine } from "../../shared/machines.ts";
import { machinePath } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { VscodeChatRow, VscodeHostState } from "../../shared/vscode.ts";
import { ApiError, getJson } from "./api.ts";
import { currentLocale, type Translate } from "./i18n.ts";

export async function fetchVscodeChats(machineId: string): Promise<VscodeChatRow[]> {
  return (await getJson<{ chats: VscodeChatRow[] }>(machinePath(machineId, "vscode/chats"))).chats;
}

export async function fetchVscodeState(machineId: string): Promise<VscodeHostState> {
  return (await getJson<{ host: VscodeHostState }>(machinePath(machineId, "vscode/state"))).host;
}

/** The PC's bridge has VS Code chats off (or predates them): it gets no group. */
export function isVscodeOff(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && (error.code === "vscode_off" || error.code === "not_found");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 7;
const RECENT_MAX = 20;

const modified = (row: VscodeChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};

/**
 * The chats one PC adds to the cross-PC Agents list (Settings → VS Code chats in Agents). `live`:
 * the working, the asking and the pinned. `recent`: those, and at most 20 of the rest modified in
 * the last 7 days (a live one is never cut), newest first.
 */
export function agentsListRows(rows: VscodeChatRow[], mode: "live" | "recent", pinned: (session: string) => boolean, now: number): VscodeChatRow[] {
  const live = (row: VscodeChatRow): boolean => row.status === "working" || row.status === "asks" || pinned(row.session);
  const newest = [...rows].sort((a, b) => modified(b) - modified(a));
  if (mode === "live") return newest.filter(live);
  const since = now - RECENT_DAYS * DAY_MS;
  let room = RECENT_MAX;
  return newest.filter((row) => {
    if (live(row)) return true;
    if (modified(row) < since || room === 0) return false;
    room -= 1;
    return true;
  });
}

/**
 * What a PC's group says over its chats while its host is not ready, in the user's words; null
 * when the host is connected and signed in (or the feature is off, which has no group).
 */
export function hostLine(host: VscodeHostState, t: Translate): string | null {
  switch (host.state) {
    case "connected": return host.signed_in ? null : t("Open VS Code on this PC once to sign the agent host in");
    case "refused": return t("VS Code's agent host speaks a protocol this bridge doesn't (server {version})", { version: host.server_version ?? "?" });
    case "no_server": return t("No VS Code server on this PC");
    case "unsupported": return t("VS Code chats are not supported on Windows yet");
    // `waiting`: this PC leaves the start to something else, and its host is not up yet
    case "starting": case "waiting": return t("Starting VS Code's agent host…");
    case "off": return null;
  }
}

/** When a chat last changed, as the Devices list says it. */
export function chatAge(row: VscodeChatRow, now: number, t: Translate): string {
  const at = modified(row);
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 2) return t("just now");
  if (minutes < 60) return t("{n} min ago", { n: minutes });
  if (minutes < 60 * 48) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(at).toLocaleDateString(currentLocale());
}

/** The state chip a chat's row draws, as an agent row's: idle and failed chats say their age instead. */
export function chatStatus(row: VscodeChatRow): "working" | "blocked" | undefined {
  return row.status === "working" ? "working" : row.status === "asks" ? "blocked" : undefined;
}

// ─── The pushes ──────────────────────────────────────────────────────────────

type VscodeMessage = Extract<ServerMessage, { type: "vscode-host" | "vscode-chat-changed" }>;
const listeners = new Set<(machineId: string, message: VscodeMessage) => void>();

export function isVscodeMessage(message: ServerMessage): message is VscodeMessage {
  return message.type === "vscode-host" || message.type === "vscode-chat-changed";
}

/** A PC's VS Code push, from App.tsx's /api/machines/events: the lists that care refetch. */
export function noteVscodeMessage(machineId: string, message: VscodeMessage): void {
  for (const listener of [...listeners]) listener(machineId, message);
}

export function onVscodeMessage(listener: (machineId: string, message: VscodeMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ─── Each PC's list ──────────────────────────────────────────────────────────

/** A PC's group: its host's state (null until read) and its chats, newest first. */
export interface VscodePc { host: VscodeHostState | null; chats: VscodeChatRow[] }

/** The clock the chats' ages and the recent window read: once a minute is enough for both. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The VS Code chats of every connected PC whose bridge has them. A PC that answers `vscode_off` is
 * left out until the roster changes (or it pushes a host state, which says it has the feature).
 */
export function useVscodeChats(machines: readonly Machine[]): ReadonlyMap<string, VscodePc> {
  const [pcs, setPcs] = useState<ReadonlyMap<string, VscodePc>>(() => new Map());
  const online = useMemo(() => machines.filter((machine) => machine.state === "connected").map((machine) => machine.id), [machines]);
  const roster = online.join("\n");
  const off = useRef(new Set<string>());
  // a later read of a PC supersedes an earlier one still in flight
  const generation = useRef(new Map<string, number>());
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const refresh = useRef((machineId: string, host?: VscodeHostState): void => {
    const turn = (generation.current.get(machineId) ?? 0) + 1;
    generation.current.set(machineId, turn);
    if (host) setPcs((current) => withPc(current, machineId, { host, chats: current.get(machineId)?.chats ?? [] }));
    void Promise.allSettled([host ? Promise.resolve(host) : fetchVscodeState(machineId), fetchVscodeChats(machineId)]).then(([state, chats]) => {
      if (generation.current.get(machineId) !== turn || !onlineRef.current.includes(machineId)) return;
      if ((state.status === "rejected" && isVscodeOff(state.reason)) || (chats.status === "rejected" && isVscodeOff(chats.reason))) {
        off.current.add(machineId);
        setPcs((current) => withoutPc(current, machineId));
        return;
      }
      setPcs((current) => {
        const previous = current.get(machineId);
        const nextHost = state.status === "fulfilled" ? state.value : previous?.host ?? null;
        // a host that is down (503) has no list; any other failure keeps what was shown
        const down = chats.status === "rejected" && chats.reason instanceof ApiError && chats.reason.status === 503;
        const nextChats = chats.status === "fulfilled" ? newestFirst(chats.value) : down ? [] : previous?.chats ?? [];
        return withPc(current, machineId, { host: nextHost, chats: nextChats });
      });
    });
  });

  useEffect(() => {
    // a new roster asks every PC again, the ones that said off too
    off.current.clear();
    setPcs((current) => new Map([...current].filter(([id]) => online.includes(id))));
    for (const id of online) refresh.current(id);
  }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onVscodeMessage((machineId, message) => {
    if (!onlineRef.current.includes(machineId)) return;
    if (message.type === "vscode-host") {
      off.current.delete(machineId);
      refresh.current(machineId, message.host);
      return;
    }
    // one chat's change is the chat screen's; its row's state comes with a list change
    if (message.session === null && !off.current.has(machineId)) refresh.current(machineId);
  }), []);

  return pcs;
}

function newestFirst(rows: VscodeChatRow[]): VscodeChatRow[] {
  return [...rows].sort((a, b) => modified(b) - modified(a));
}

function withPc(current: ReadonlyMap<string, VscodePc>, machineId: string, pc: VscodePc): ReadonlyMap<string, VscodePc> {
  const previous = current.get(machineId);
  if (previous && JSON.stringify(previous) === JSON.stringify(pc)) return current;
  return new Map(current).set(machineId, pc);
}

function withoutPc(current: ReadonlyMap<string, VscodePc>, machineId: string): ReadonlyMap<string, VscodePc> {
  if (!current.has(machineId)) return current;
  const next = new Map(current);
  next.delete(machineId);
  return next;
}
