/**
 * Each PC's VS Code chats, for the sidebar: the list its bridge reads from VS Code's agent host
 * (server/vscode), and the host's state. A PC whose bridge has the feature off (404 `vscode_off`)
 * has no group and is not asked again until the roster changes; the pushes (`vscode-host`,
 * `vscode-chat-changed`) that App.tsx hands to noteVscodeMessage refetch a PC's list.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Machine, MachineEvent } from "../../shared/machines.ts";
import { machinePath } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { VscodeAgent, VscodeAnswer, VscodeChatRead, VscodeChatRow, VscodeConfirm, VscodeHostState, VscodeModel, VscodeNew, VscodeNewResult, VscodeSend } from "../../shared/vscode.ts";
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

// ─── One chat ────────────────────────────────────────────────────────────────

/** GET vscode/chat: the chat as its PC's host has it; `before` (a read's `cursor`) asks for the turns before. */
export function fetchVscodeChat(machineId: string, session: string, before?: string): Promise<VscodeChatRead> {
  const query = new URLSearchParams({ session, ...(before ? { before } : {}) });
  return getJson<VscodeChatRead>(machinePath(machineId, `vscode/chat?${query.toString()}`));
}

async function post<T>(machineId: string, path: string, body: unknown): Promise<T> {
  // once: a failure is the user's to retry (the phone never re-sends on its own)
  return getJson<T>(machinePath(machineId, path), {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
}

/** The models the PC's Copilot offers, and the custom agents enabled in this chat. */
export function fetchVscodeModels(machineId: string, session: string): Promise<{ models: VscodeModel[]; agents: VscodeAgent[] }> {
  return getJson(machinePath(machineId, `vscode/models?${new URLSearchParams({ session }).toString()}`));
}

/** Keeps the bridge subscribed to this chat for its lease (90 s): the screen renews it while it is shown. */
export async function watchVscodeChat(machineId: string, session: string): Promise<void> {
  await post(machineId, "vscode/chat/watch", { session });
}

export function answerVscode(machineId: string, body: VscodeAnswer): Promise<{ ok: true }> {
  return post(machineId, "vscode/chat/answer", body);
}

export function confirmVscode(machineId: string, body: VscodeConfirm): Promise<{ ok: true }> {
  return post(machineId, "vscode/chat/confirm", body);
}

/** Writes the model into the chat's shared draft, so VS Code's own picker shows it too. */
export async function setVscodeDraftModel(machineId: string, session: string, model: { id: string; effort?: string }): Promise<void> {
  await post(machineId, "vscode/chat/draft", { session, model });
}

/** The model and agent the phone picked for a chat's next message; `agent: null` is "Agent", no custom agent. */
export interface VscodeChoice { model?: { id: string; effort?: string }; agent?: string | null }

const choiceKey = (machineId: string, session: string): string => `herdr-web-ui:vscode-choice:${machineId}:${session}`;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** The phone's pending choice for this chat (sessionStorage): what its next send carries. */
export function chosenFor(machineId: string, session: string): VscodeChoice {
  try {
    const raw = storage()?.getItem(choiceKey(machineId, session));
    if (!raw) return {};
    const value = JSON.parse(raw) as VscodeChoice;
    const choice: VscodeChoice = {};
    if (value.model && typeof value.model.id === "string") choice.model = typeof value.model.effort === "string" ? { id: value.model.id, effort: value.model.effort } : { id: value.model.id };
    if (value.agent === null || typeof value.agent === "string") choice.agent = value.agent;
    return choice;
  } catch {
    return {};
  }
}

/** Adds a pick to the chat's pending choice. */
export function choose(machineId: string, session: string, change: VscodeChoice): void {
  const next = { ...chosenFor(machineId, session), ...change };
  try { storage()?.setItem(choiceKey(machineId, session), JSON.stringify(next)); } catch { /* the pick holds for this screen only */ }
}

function clearChoice(machineId: string, session: string): void {
  try { storage()?.removeItem(choiceKey(machineId, session)); } catch { /* nothing kept */ }
}

// ─── The composer's draft ────────────────────────────────────────────────────

const draftKey = (machineId: string, session: string): string => `herdr-web-ui:vscode-draft:${machineId}:${session}`;

/** What the chat's box held when it was last left: its words wait there until sent or cleared. */
export function readVscodeDraft(machineId: string, session: string): string {
  try { return storage()?.getItem(draftKey(machineId, session)) ?? ""; } catch { return ""; }
}

export function keepVscodeDraft(machineId: string, session: string, text: string): void {
  try {
    if (text === "") storage()?.removeItem(draftKey(machineId, session));
    else storage()?.setItem(draftKey(machineId, session), text);
  } catch { /* the box still holds it */ }
}

/** What a chat used last, as its read says: the pills show it while the phone has picked nothing. */
export interface VscodeLast { model: { id: string; effort: string | null } | null; agent: string | null }

/**
 * What a message carries, as the pills show it: the phone's pending pick, else the chat's last
 * model and agent. Every message carries them, since the host reads an absent model as its
 * default and an absent agent as none. "Agent" (null) and an unknown model go as absent.
 */
export function carriedChoice(choice: VscodeChoice, last: VscodeLast): Pick<VscodeSend, "model" | "agent"> {
  const model = choice.model ?? (last.model ? { id: last.model.id, ...(last.model.effort !== null ? { effort: last.model.effort } : {}) } : undefined);
  const agent = "agent" in choice ? choice.agent ?? null : last.agent;
  return { ...(model ? { model } : {}), ...(agent !== null ? { agent } : {}) };
}

/**
 * Sends one message with what the pills show (carriedChoice). Failed, nothing changes and nothing
 * is retried. Sent, the stored draft is let go, unless more was typed meanwhile, whether or not the
 * chat is still on screen: a sent message never comes back in the box to be sent twice. The
 * pending pick stays until a read shows it as the chat's last (settleChoice), so a queued message,
 * a read that is a moment behind, or a pick made during the send never lose it.
 */
export async function sendVscode(machineId: string, body: VscodeSend, last: VscodeLast): Promise<{ queued: boolean }> {
  const full: VscodeSend = { ...body, ...carriedChoice(chosenFor(machineId, body.session), last) };
  const result = await post<{ queued: boolean }>(machineId, "vscode/chat/send", full);
  if (readVscodeDraft(machineId, body.session).trim() === body.text.trim()) keepVscodeDraft(machineId, body.session, "");
  return result;
}

/**
 * The chat's pending pick once a read says what the chat used last: a pick the chat now uses is
 * let go (the pills then show the chat's own, the same values, and follow a change made in VS
 * Code after it); any other pick stays pending.
 */
export function settleChoice(machineId: string, session: string, last: VscodeLast): VscodeChoice {
  const choice = chosenFor(machineId, session);
  const modelUsed = choice.model === undefined || (last.model?.id === choice.model.id && last.model.effort === (choice.model.effort ?? null));
  const agentUsed = !("agent" in choice) || (choice.agent ?? null) === last.agent;
  if (Object.keys(choice).length > 0 && modelUsed && agentUsed) { clearChoice(machineId, session); return {}; }
  return choice;
}

// ─── Words for the screens ───────────────────────────────────────────────────

/** What a failed request says to the user: the bridge's own message, else the error's. */
export function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);
}

/** An agent's name from its file's uri (`…/Report.agent.md` → Report), for an agent the list does not name. */
export function agentName(uri: string): string {
  const file = decodeURIComponent(uri.split("/").pop() ?? uri);
  return file.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "") || uri;
}

/** A folder's last name (`/tmp/repo/` → repo), as its chip says it. */
export function basename(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

// ─── A new chat ──────────────────────────────────────────────────────────────

const FOLDERS_MAX = 8;

/** The folders a new chat on this PC offers as chips: its chats' folders, the newest chat's first, at most 8. */
export function folderChoices(rows: VscodeChatRow[]): string[] {
  const folders: string[] = [];
  for (const row of newestFirst(rows)) {
    if (row.cwd === null || row.cwd === "" || folders.includes(row.cwd)) continue;
    folders.push(row.cwd);
    if (folders.length === FOLDERS_MAX) break;
  }
  return folders;
}

/**
 * Starts a chat in a folder of the PC with its first message, once (never retried): the session made.
 * A refusal throws and nothing was made. When the chat was made but its first message did not go
 * (`sent: false`), the words wait in that chat's composer and the picks in its pending choice, for
 * the user to send there: the phone never makes another chat nor sends them on its own.
 */
export async function createVscodeChat(machineId: string, body: VscodeNew): Promise<string> {
  const result = await post<VscodeNewResult>(machineId, "vscode/chat/new", body);
  if (result.sent === false) {
    keepVscodeDraft(machineId, result.session, body.text);
    const change: VscodeChoice = {};
    if (body.model) change.model = body.model;
    if (body.agent !== undefined) change.agent = body.agent;
    if (Object.keys(change).length > 0) choose(machineId, result.session, change);
  }
  return result.session;
}

/**
 * The chat whose models and agents a new chat in `cwd` offers (they are a session's): the newest
 * chat in that folder, else the PC's newest; null when the PC has none.
 */
export function sessionForFolder(rows: VscodeChatRow[], cwd: string): string | null {
  const newest = newestFirst(rows);
  return (newest.find((row) => row.cwd === cwd.trim()) ?? newest[0])?.session ?? null;
}

/**
 * A chat's models under their provider: the part of the id before its first `/`. An id with none
 * is one of the host's own Copilot models; that group (provider null) comes first.
 */
export function groupModels(models: readonly VscodeModel[]): { provider: string | null; models: VscodeModel[] }[] {
  const groups = new Map<string | null, VscodeModel[]>();
  for (const model of models) {
    const at = model.id.indexOf("/");
    const provider = at > 0 ? model.id.slice(0, at) : null;
    groups.set(provider, [...groups.get(provider) ?? [], model]);
  }
  const own = groups.get(null);
  const named = [...groups].filter(([provider]) => provider !== null);
  return [...(own ? [[null, own] as const] : []), ...named].map(([provider, list]) => ({ provider, models: list }));
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

/**
 * App.tsx's event stream hands every event here first: a PC's VS Code push is taken (true) and
 * goes to the lists and the chat screen, before the stream's pane-snapshot bookkeeping, which it
 * must not touch (a chat streaming would otherwise throw away every roster poll).
 */
export function takeVscodeEvent(payload: MachineEvent, known: (machineId: string) => boolean): boolean {
  if (payload.type !== "machine-message" || !isVscodeMessage(payload.message)) return false;
  if (known(payload.machine_id)) noteVscodeMessage(payload.machine_id, payload.message);
  return true;
}

/**
 * `run`, at most one at a time: a call while one runs makes exactly one more run after it, however
 * many calls came meanwhile. The chat screen's re-reads on pushes go through this.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const start = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await run().catch(() => undefined); } while (again);
      } finally { running = null; }
    })();
    return running;
  };
  return start;
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
