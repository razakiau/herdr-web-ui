/**
 * Each PC's host chats, for the sidebar: the list its bridge reads from VS Code's agent host
 * (server/agent-host), and the host's state. A PC whose bridge has the feature off (404 `host_chats_off`)
 * has no group and is not asked again until the roster changes; the pushes (`host-chat-state`,
 * `host-chat-changed`) that App.tsx hands to noteHostChatMessage refetch a PC's list, and so do the
 * page coming back on screen and the app's event stream reopening (onHostChatResume).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { Machine, MachineEvent } from "../../shared/machines.ts";
import { machinePath } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { HostAgent, HostAnswer, HostChatRead, HostChatRow, HostConfirm, AgentHostState, HostModel, HostNew, HostNewResult, HostSend } from "../../shared/host-chats.ts";
import { ApiError, getJson } from "./api.ts";
import { currentLocale, type Translate } from "./i18n.ts";

export async function fetchHostChats(machineId: string): Promise<HostChatRow[]> {
  return (await getJson<{ chats: HostChatRow[] }>(machinePath(machineId, "host-chats/chats"))).chats;
}

export async function fetchHostState(machineId: string): Promise<AgentHostState> {
  return (await getJson<{ host: AgentHostState }>(machinePath(machineId, "host-chats/state"))).host;
}

/** The PC's bridge has host chats off (or predates them): it gets no group. */
export function isHostChatsOff(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && (error.code === "host_chats_off" || error.code === "not_found");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 7;
const RECENT_MAX = 20;

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};

/**
 * The chats one PC adds to the cross-PC Agents list (Settings → Copilot chats in Agents). `live`:
 * the working, the asking and the pinned. `recent`: those, and at most 20 of the rest modified in
 * the last 7 days (a live one is never cut), newest first.
 */
export function agentsListRows(rows: HostChatRow[], mode: "live" | "recent", pinned: (session: string) => boolean, now: number): HostChatRow[] {
  const live = (row: HostChatRow): boolean => row.status === "working" || row.status === "asks" || pinned(row.session);
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
export function hostLine(host: AgentHostState, t: Translate): string | null {
  switch (host.state) {
    case "connected": return host.signed_in ? null : t("The agent host on this PC is not signed in to Copilot");
    case "refused": return t("The agent host refused this app's protocol (it speaks {version})", { version: host.server_version ?? "?" });
    case "no_server": return t("No agent host on this PC");
    case "unsupported": return t("The agent host is not supported on Windows yet");
    // `waiting`: this PC leaves the start to something else, and its host is not up yet
    case "starting": case "waiting": return t("Starting the agent host…");
    case "off": return null;
  }
}

/** When a chat last changed, as the Devices list says it. */
export function chatAge(row: HostChatRow, now: number, t: Translate): string {
  const at = modified(row);
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 2) return t("just now");
  if (minutes < 60) return t("{n} min ago", { n: minutes });
  if (minutes < 60 * 48) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(at).toLocaleDateString(currentLocale());
}

/** The state chip a chat's row draws, as an agent row's: idle and failed chats say their age instead. */
export function chatStatus(row: HostChatRow): "working" | "blocked" | undefined {
  return row.status === "working" ? "working" : row.status === "asks" ? "blocked" : undefined;
}

// ─── One chat ────────────────────────────────────────────────────────────────

/** GET host-chats/chat: the chat as its PC's host has it; `before` (a read's `cursor`) asks for the turns before. */
export async function fetchHostChat(machineId: string, session: string, before?: string): Promise<HostChatRead> {
  const query = new URLSearchParams({ session, ...(before ? { before } : {}) });
  const read = await getJson<HostChatRead>(machinePath(machineId, `host-chats/chat?${query.toString()}`));
  // a send whose answer was lost but that went: its id is the chat's now, never to be reused
  const attempt = storedAttempt(machineId, session);
  if (attempt && (read.message_ids ?? []).includes(attempt.id)) dropAttempt(machineId, session, attempt.id);
  return read;
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
export function fetchHostModels(machineId: string, session: string): Promise<{ models: HostModel[]; agents: HostAgent[] }> {
  return getJson(machinePath(machineId, `host-chats/models?${new URLSearchParams({ session }).toString()}`));
}

/** Keeps the bridge subscribed to this chat for its lease (90 s): the screen renews it while it is shown. */
export async function watchHostChat(machineId: string, session: string): Promise<void> {
  await post(machineId, "host-chats/chat/watch", { session });
}

export function answerHost(machineId: string, body: HostAnswer): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/answer", body);
}

export function confirmHost(machineId: string, body: HostConfirm): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/confirm", body);
}

/** Writes the model into the chat's shared draft, so VS Code's own picker shows it too. */
export async function setHostDraftModel(machineId: string, session: string, model: { id: string; effort?: string }): Promise<void> {
  await post(machineId, "host-chats/chat/draft", { session, model });
}

/** The model and agent the phone picked for a chat's next message; `agent: null` is "Agent", no custom agent. */
export interface HostChoice { model?: { id: string; effort?: string }; agent?: string | null }

const choiceKey = (machineId: string, session: string): string => `herdr-web-ui:host-chat-choice:${machineId}:${session}`;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** The phone's pending choice for this chat (sessionStorage): what its next send carries. */
export function chosenFor(machineId: string, session: string): HostChoice {
  try {
    const raw = storage()?.getItem(choiceKey(machineId, session));
    if (!raw) return {};
    const value = JSON.parse(raw) as HostChoice;
    const choice: HostChoice = {};
    if (value.model && typeof value.model.id === "string") choice.model = typeof value.model.effort === "string" ? { id: value.model.id, effort: value.model.effort } : { id: value.model.id };
    if (value.agent === null || typeof value.agent === "string") choice.agent = value.agent;
    return choice;
  } catch {
    return {};
  }
}

/** Adds a pick to the chat's pending choice. */
export function choose(machineId: string, session: string, change: HostChoice): void {
  const next = { ...chosenFor(machineId, session), ...change };
  try { storage()?.setItem(choiceKey(machineId, session), JSON.stringify(next)); } catch { /* the pick holds for this screen only */ }
}

function clearChoice(machineId: string, session: string): void {
  try { storage()?.removeItem(choiceKey(machineId, session)); } catch { /* nothing kept */ }
}

// ─── The composer's draft ────────────────────────────────────────────────────

const draftKey = (machineId: string, session: string): string => `herdr-web-ui:host-chat-draft:${machineId}:${session}`;

/** What the chat's box held when it was last left: its words wait there until sent or cleared. */
export function readHostDraft(machineId: string, session: string): string {
  try { return storage()?.getItem(draftKey(machineId, session)) ?? ""; } catch { return ""; }
}

export function keepHostDraft(machineId: string, session: string, text: string): void {
  try {
    if (text === "") storage()?.removeItem(draftKey(machineId, session));
    else storage()?.setItem(draftKey(machineId, session), text);
  } catch { /* the box still holds it */ }
}

// ─── One id per attempt ──────────────────────────────────────────────────────

const newId = (): string => globalThis.crypto.randomUUID();

/** How long a failed send's id is reused for the same words; a retry after it is a new message. */
export const HOST_ATTEMPT_TTL_MS = 10 * 60_000;

/**
 * The id an attempt goes under: the previous attempt's when it was for the same `key` (the same
 * words sent again after a failure, so the bridge dispatches them once), else a new one.
 */
export function attemptFor(previous: { key: string; id: string } | null, key: string, mint: () => string = newId): { key: string; id: string } {
  return previous !== null && previous.key === key ? previous : { key, id: mint() };
}

const attemptKey = (machineId: string, session: string): string => `herdr-web-ui:host-chat-send:${machineId}:${session}`;

/**
 * The chat's failed send whose id a retry of the same words reuses: none once it is older than
 * HOST_ATTEMPT_TTL_MS (or carries no time), so later words that happen to match are a new message.
 */
function storedAttempt(machineId: string, session: string, now = Date.now()): { key: string; id: string } | null {
  try {
    const raw = storage()?.getItem(attemptKey(machineId, session));
    const value = raw ? JSON.parse(raw) as { key?: unknown; id?: unknown; at?: unknown } : null;
    if (!value || typeof value.key !== "string" || typeof value.id !== "string" || typeof value.at !== "number" || now - value.at > HOST_ATTEMPT_TTL_MS) return null;
    return { key: value.key, id: value.id };
  } catch { return null; }
}

function keepAttempt(machineId: string, session: string, attempt: { key: string; id: string }): void {
  try { storage()?.setItem(attemptKey(machineId, session), JSON.stringify({ ...attempt, at: Date.now() })); } catch { /* this attempt only */ }
}

function dropAttempt(machineId: string, session: string, id: string): void {
  try {
    const raw = storage()?.getItem(attemptKey(machineId, session));
    if (raw && (JSON.parse(raw) as { id?: unknown }).id === id) storage()?.removeItem(attemptKey(machineId, session));
  } catch { /* nothing kept */ }
}

/**
 * Whether a failed send or new chat may have gone out anyway: no answer (a network failure), or
 * the proxy's 502/504. The user is told to send again, which is safe: the same id goes once.
 */
export function maybeSent(cause: unknown): boolean {
  if (cause instanceof ApiError) return cause.status === 502 || cause.status === 504;
  return cause instanceof TypeError;
}

/** What a failed send or new chat says (sendErrorText for the chat's composer, which adds "Not sent"). */
export function sendErrorText(cause: unknown, t: Translate, plain = false): string {
  if (maybeSent(cause)) return t("Couldn't confirm it was sent. Send again: it won't go twice.");
  return plain ? errorText(cause) : t("Not sent: {error}", { error: errorText(cause) });
}

/** What a chat used last, as its read says: the pills show it while the phone has picked nothing. */
export interface HostLast { model: { id: string; effort: string | null } | null; agent: string | null }

/**
 * What a message carries, as the pills show it: the phone's pending pick, else the chat's last
 * model and agent. Every message carries them, since the host reads an absent model as its
 * default and an absent agent as none. "Agent" (null) and an unknown model go as absent.
 */
export function carriedChoice(choice: HostChoice, last: HostLast): Pick<HostSend, "model" | "agent"> {
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
export async function sendHost(machineId: string, body: Omit<HostSend, "id">, last: HostLast): Promise<{ queued: boolean }> {
  // the same words again after a failure go under the same id (kept with the draft, so leaving
  // the screen keeps it too); other words, or the next message after a sent one, get a new one
  const previous = storedAttempt(machineId, body.session);
  const attempt = attemptFor(previous, body.text.trim());
  // the first try's time stands: a retry does not stretch the window it is reused in
  if (attempt !== previous) keepAttempt(machineId, body.session, attempt);
  const full: HostSend = { ...body, id: attempt.id, ...carriedChoice(chosenFor(machineId, body.session), last) };
  const result = await post<{ queued: boolean }>(machineId, "host-chats/chat/send", full);
  dropAttempt(machineId, body.session, attempt.id);
  if (readHostDraft(machineId, body.session).trim() === body.text.trim()) keepHostDraft(machineId, body.session, "");
  return result;
}

/**
 * The chat's pending pick once a read says what the chat used last: a pick the chat now uses is
 * let go (the pills then show the chat's own, the same values, and follow a change made in VS
 * Code after it); any other pick stays pending.
 */
export function settleChoice(machineId: string, session: string, last: HostLast): HostChoice {
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
export function folderChoices(rows: HostChatRow[]): string[] {
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
export async function createHostChat(machineId: string, body: HostNew): Promise<string> {
  const result = await post<HostNewResult>(machineId, "host-chats/chat/new", body);
  if (result.sent === false) {
    keepHostDraft(machineId, result.session, body.text);
    const change: HostChoice = {};
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
export function sessionForFolder(rows: HostChatRow[], cwd: string): string | null {
  const newest = newestFirst(rows);
  return (newest.find((row) => row.cwd === cwd.trim()) ?? newest[0])?.session ?? null;
}

/**
 * A chat's models under their provider: the part of the id before its first `/`. An id with none
 * is one of the host's own Copilot models; that group (provider null) comes first.
 */
export function groupModels(models: readonly HostModel[]): { provider: string | null; models: HostModel[] }[] {
  const groups = new Map<string | null, HostModel[]>();
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

type HostChatMessage = Extract<ServerMessage, { type: "host-chat-state" | "host-chat-changed" }>;
const listeners = new Set<(machineId: string, message: HostChatMessage) => void>();

export function isHostChatMessage(message: ServerMessage): message is HostChatMessage {
  return message.type === "host-chat-state" || message.type === "host-chat-changed";
}

/** A PC's host chat push, from App.tsx's /api/machines/events: the lists that care refetch. */
export function noteHostChatMessage(machineId: string, message: HostChatMessage): void {
  for (const listener of [...listeners]) listener(machineId, message);
}

/**
 * App.tsx's event stream hands every event here first: a PC's host chat push is taken (true) and
 * goes to the lists and the chat screen, before the stream's pane-snapshot bookkeeping, which it
 * must not touch (a chat streaming would otherwise throw away every roster poll).
 */
export function takeHostChatEvent(payload: MachineEvent, known: (machineId: string) => boolean): boolean {
  if (payload.type !== "machine-message" || !isHostChatMessage(payload.message)) return false;
  if (known(payload.machine_id)) noteHostChatMessage(payload.machine_id, payload.message);
  return true;
}

const resumeListeners = new Set<() => void>();

/** App.tsx's event stream opened (or reopened after a drop): pushes may have been missed meanwhile. */
export function noteHostChatStreamOpen(): void {
  for (const listener of [...resumeListeners]) listener();
}

/**
 * Calls `listener` when what is shown may be stale: the page is shown again (a phone back from
 * the background) or the app's event stream (re)opened. The lists and the open chat read again.
 */
export function onHostChatResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  const shown = (): void => { if (document.visibilityState === "visible") listener(); };
  const page = typeof document === "undefined" ? null : document;
  page?.addEventListener("visibilitychange", shown);
  return () => { resumeListeners.delete(listener); page?.removeEventListener("visibilitychange", shown); };
}

export function onHostChatMessage(listener: (machineId: string, message: HostChatMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ─── Each PC's list ──────────────────────────────────────────────────────────

/** A PC's group: its host's state (null until read) and its chats, newest first. */
export interface HostPc { host: AgentHostState | null; chats: HostChatRow[] }

/** The clock the chats' ages and the recent window read: once a minute is enough for both. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A read failure that says the PC's bridge has the feature on and its host is down: it still gets a group. */
function hostDownError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === "agent_host_down";
}

/**
 * The PCs' groups, kept outside React so the rules are testable: which PC gets a group, when each
 * is read again, and that a later read supersedes an earlier one still in flight.
 *
 * - A PC gets a group only when its host state reads, or its bridge says its host is down (503
 *   `agent_host_down`). `host_chats_off` (404) and any other failure (502, 504, a network error) give it
 *   none: off stays off through a transient error. A PC already shown keeps what it shows.
 * - A PC that said `host_chats_off` is asked again on the next roster change, or when it pushes a
 *   host state (which says it has the feature).
 * - Every other online PC is read again on its list pushes, and on `resume()`: the page shown
 *   again, or the app's event stream (re)opened, after which any push may have been missed.
 */
export class HostPcs {
  private pcs: ReadonlyMap<string, HostPc> = new Map();
  private online: readonly string[] = [];
  private readonly off = new Set<string>();
  private readonly generation = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly reads = new Set<Promise<void>>();

  readonly get = (): ReadonlyMap<string, HostPc> => this.pcs;

  /** Settles once every read started so far has (tests wait on this rather than on time). */
  async idle(): Promise<void> {
    while (this.reads.size > 0) await Promise.all([...this.reads]);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** A new roster asks every online PC again, the ones that said off too. */
  setRoster(online: readonly string[]): void {
    this.online = online;
    this.off.clear();
    this.set(new Map([...this.pcs].filter(([id]) => online.includes(id))));
    for (const id of online) this.refresh(id);
  }

  /** Reads every online PC again but the ones that said off. */
  resume(): void {
    for (const id of this.online) if (!this.off.has(id)) this.refresh(id);
  }

  message(machineId: string, message: HostChatMessage): void {
    if (!this.online.includes(machineId)) return;
    if (message.type === "host-chat-state") {
      this.off.delete(machineId);
      this.refresh(machineId, message.host);
      return;
    }
    // one chat's change is the chat screen's; its row's state comes with a list change
    if (message.session === null && !this.off.has(machineId)) this.refresh(machineId);
  }

  /** The pushes and resume() wired up, until the returned function is called. */
  listen(): () => void {
    const stops = [onHostChatMessage((machineId, message) => this.message(machineId, message)), onHostChatResume(() => this.resume())];
    return () => { for (const stop of stops) stop(); };
  }

  refresh(machineId: string, host?: AgentHostState): void {
    const turn = (this.generation.get(machineId) ?? 0) + 1;
    this.generation.set(machineId, turn);
    if (host) this.set(withPc(this.pcs, machineId, { host, chats: this.pcs.get(machineId)?.chats ?? [] }));
    const read = Promise.allSettled([host ? Promise.resolve(host) : fetchHostState(machineId), fetchHostChats(machineId)]).then(([state, chats]) => {
      if (this.generation.get(machineId) !== turn || !this.online.includes(machineId)) return;
      if ((state.status === "rejected" && isHostChatsOff(state.reason)) || (chats.status === "rejected" && isHostChatsOff(chats.reason))) {
        this.off.add(machineId);
        this.set(withoutPc(this.pcs, machineId));
        return;
      }
      const previous = this.pcs.get(machineId);
      const on = state.status === "fulfilled" || hostDownError(state.reason) || hostDownError(chats.status === "rejected" ? chats.reason : null);
      // a PC not shown yet whose bridge could not say the feature is on gets no group
      if (!on && !previous) return;
      const nextHost = state.status === "fulfilled" ? state.value : previous?.host ?? null;
      // a host that is down (503) has no list; any other failure keeps what was shown
      const down = chats.status === "rejected" && chats.reason instanceof ApiError && chats.reason.status === 503;
      const nextChats = chats.status === "fulfilled" ? newestFirst(chats.value) : down ? [] : previous?.chats ?? [];
      this.set(withPc(this.pcs, machineId, { host: nextHost, chats: nextChats }));
    });
    this.reads.add(read);
    void read.finally(() => this.reads.delete(read));
  }

  private set(next: ReadonlyMap<string, HostPc>): void {
    if (next === this.pcs) return;
    this.pcs = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The host chats of every connected PC whose bridge has them (HostPcs, in React). */
export function useHostChats(machines: readonly Machine[]): ReadonlyMap<string, HostPc> {
  const [tracker] = useState(() => new HostPcs());
  const pcs = useSyncExternalStore(tracker.subscribe, tracker.get);
  const online = useMemo(() => machines.filter((machine) => machine.state === "connected").map((machine) => machine.id), [machines]);
  const roster = online.join("\n");
  useEffect(() => { tracker.setRoster(online); }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => tracker.listen(), [tracker]);
  return pcs;
}

function newestFirst(rows: HostChatRow[]): HostChatRow[] {
  return [...rows].sort((a, b) => modified(b) - modified(a));
}

function withPc(current: ReadonlyMap<string, HostPc>, machineId: string, pc: HostPc): ReadonlyMap<string, HostPc> {
  const previous = current.get(machineId);
  if (previous && JSON.stringify(previous) === JSON.stringify(pc)) return current;
  return new Map(current).set(machineId, pc);
}

function withoutPc(current: ReadonlyMap<string, HostPc>, machineId: string): ReadonlyMap<string, HostPc> {
  if (!current.has(machineId)) return current;
  const next = new Map(current);
  next.delete(machineId);
  return next;
}
