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
import { composerDrafts } from "./composerDraft.ts";
import type { HostAgent, HostAnswer, HostChatRead, HostChatRow, HostConfirm, HostContextUsage, AgentHostState, HostModel, HostNew, HostNewResult, HostSend, HostSendResult, HostSessionConfig } from "../../shared/host-chats.ts";
import { ApiError, assertAttachable, base64FromBytes, getJson } from "./api.ts";
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

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};

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
  if (minutes < 60 * 24 * 30) return t("{n} days ago", { n: Math.round(minutes / (60 * 24)) });
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

export function fetchHostConfig(machineId: string, session: string): Promise<HostSessionConfig> {
  return getJson(machinePath(machineId, `host-chats/session/config?${new URLSearchParams({ session }).toString()}`));
}

/** The chat's folder's files matching `query`, for "@" (as a pane chat lists its own). */
export async function fetchHostFiles(machineId: string, session: string, query: string, limit = 20): Promise<string[]> {
  return (await getJson<{ files: string[] }>(machinePath(machineId, `host-chats/files?${new URLSearchParams({ session, q: query, limit: String(limit) }).toString()}`))).files;
}

/**
 * Stores an attached file in the chat's folder on its PC (`.herdr-web-ui/`, where a pane's go): its
 * path, which the message then carries as an attachment. Refused before reading for a file over
 * the limit (AttachmentTooLargeError), as a pane's upload is.
 */
export async function uploadHostFile(machineId: string, session: string, file: File): Promise<string> {
  assertAttachable(file);
  const data = base64FromBytes(new Uint8Array(await file.arrayBuffer()));
  return (await post<{ path: string }>(machineId, "host-chats/chat/upload", { session, media_type: file.type || "application/octet-stream", data, ...(file.name ? { name: file.name } : {}) })).path;
}

/** Sets the chat's mode or approvals on its host (only what is given): it stays the chat's, as in VS Code. */
export function setHostConfig(machineId: string, session: string, change: { mode?: string; approvals?: string }): Promise<{ ok: true }> {
  return post(machineId, "host-chats/session/config", { session, ...change });
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

// ─── A chat's actions ─────────────────────────────────────────────────────────
// The row and tab menus' Rename, Mark as read / unread, Mark as done / Restore and Delete: the
// bridge sends each to the PC's host as VS Code would, so VS Code shows the change too. Pins are
// this app's own (lib/sidebarPins.ts): the host has none.

export function renameHostChat(machineId: string, session: string, title: string): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/rename", { session, title });
}

export function markHostChatRead(machineId: string, session: string, read: boolean): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/read", { session, read });
}

/** Mark as done (archived) or Restore. */
export function archiveHostChat(machineId: string, session: string, archived: boolean): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/archive", { session, archived });
}

/** Deletes the chat on its PC (a running turn is cancelled first): VS Code loses it too. */
export function deleteHostChat(machineId: string, session: string): Promise<{ ok: true }> {
  return post(machineId, "host-chats/chat/delete", { session });
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

/** Where a host chat's box keeps its words (the app's Composer draft store reads and writes it too). */
export const hostDraftKey = (machineId: string, session: string): string => `herdr-web-ui:host-chat-draft:${machineId}:${session}`;
const draftKey = hostDraftKey;

/**
 * What the chat's box held when it was last left: its words wait there until sent or cleared. The
 * app's composer draft store holds it, as it holds a pane's, so the box and these read one draft.
 */
export function readHostDraft(machineId: string, session: string): string {
  return composerDrafts.read(draftKey(machineId, session)).text;
}

export function keepHostDraft(machineId: string, session: string, text: string): void {
  composerDrafts.set(draftKey(machineId, session), text);
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
/** `composer`: the app's Composer sent it and settles its own draft; else the words sent leave the draft here. */
export async function sendHost(machineId: string, body: Omit<HostSend, "id">, last: HostLast, composer = false): Promise<HostSendResult> {
  // the same words again after a failure go under the same id (kept with the draft, so leaving
  // the screen keeps it too); other words, or the next message after a sent one, get a new one
  const previous = storedAttempt(machineId, body.session);
  const attempt = attemptFor(previous, body.text.trim());
  // the first try's time stands: a retry does not stretch the window it is reused in
  if (attempt !== previous) keepAttempt(machineId, body.session, attempt);
  const full: HostSend = { ...body, id: attempt.id, ...carriedChoice(chosenFor(machineId, body.session), last) };
  const result = await post<HostSendResult>(machineId, "host-chats/chat/send", full);
  dropAttempt(machineId, body.session, attempt.id);
  if (!composer && readHostDraft(machineId, body.session).trim() === body.text.trim()) keepHostDraft(machineId, body.session, "");
  return result;
}

/** Stops the chat's running turn (a chat with none is left be). */
export async function stopHost(machineId: string, session: string): Promise<void> {
  await post(machineId, "host-chats/chat/stop", { session });
}

/** Takes a steering or queued message off before it goes. */
export async function removeHostPending(machineId: string, session: string, id: string): Promise<void> {
  await post(machineId, "host-chats/chat/pending/remove", { session, id });
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

/**
 * A PC's group: its host's state (null until read) and its chats, newest first. `stale`: the last
 * list read failed (a down host has none), so `chats` is not the PC's word on which chats exist.
 */
export interface HostPc { host: AgentHostState | null; chats: HostChatRow[]; stale?: true }

/**
 * Whether the chat on screen is to be marked read, as VS Code does: when it is opened unread, and
 * when its turn ends while it is shown (`was` is its row before, undefined on opening). A chat the
 * user marks unread while it is open stays unread: only a change of what is seen reads it.
 */
export function readsOnView(was: HostChatRow | undefined, now: HostChatRow | undefined): boolean {
  if (now === undefined || !now.unread || now.status === "working") return false;
  return was === undefined || was.status === "working";
}

/**
 * What a working host chat waits on, in VS Code's order (chatListRenderer's persistent progress):
 * an open question, then tool calls waiting for a yes or no, then background work (subagents and
 * commands); null when none, and the app's own working word stands. A bridge from before these
 * fields sends none of them: nothing to say.
 */
export function hostStatusLine(read: HostChatRead, t: Translate): string | null {
  if (read.prompt?.kind === "question") return t("Waiting for your response");
  const confirmations = read.confirmations ?? 0;
  if (confirmations > 0) return confirmations === 1 ? t("1 confirmation pending") : t("{0} confirmations pending", { 0: confirmations });
  const { subagents, commands } = read.background ?? { subagents: 0, commands: 0 };
  const agents = subagents === 1 ? t("1 subagent") : subagents > 1 ? t("{0} subagents", { 0: subagents }) : null;
  const shells = commands === 1 ? t("1 background command") : commands > 1 ? t("{0} background commands", { 0: commands }) : null;
  if (agents && shells) return t("{0} and {1} running", { 0: agents, 1: shells });
  if (agents) return subagents === 1 ? t("1 subagent running") : t("{0} subagents running", { 0: subagents });
  if (shells) return commands === 1 ? t("1 background command running") : t("{0} background commands running", { 0: commands });
  return null;
}

/** Tokens as VS Code's meter writes them: 850, 1.5K, 84K, 1M. */
function tokens(value: number): string {
  if (value < 1000) return String(value);
  const [scaled, unit] = value >= 1_000_000 ? [value / 1_000_000, "M"] : [value / 1000, "K"];
  return `${scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${unit}`;
}

/**
 * The chat's context window as a meter: "42% · 84K / 200K" and the bar's share (at most 100).
 * Null when Copilot reported nothing usable.
 */
export function contextMeter(usage: HostContextUsage | null): { percent: number; label: string } | null {
  if (usage === null || !Number.isFinite(usage.currentTokens) || !Number.isFinite(usage.tokenLimit) || usage.tokenLimit <= 0) return null;
  const share = Math.round((usage.currentTokens / usage.tokenLimit) * 100);
  return { percent: Math.min(100, share), label: `${share}% · ${tokens(usage.currentTokens)} / ${tokens(usage.tokenLimit)}` };
}

/**
 * The header's connection chip for an open host chat (it has no pane, whose stream sets it): live
 * while its PC's host is connected and its list current. A read that is loading or failed says so
 * in the chat itself; here it read as "reconnecting" and pulsed while the host was up.
 */
export function hostChatLive(pc: HostPc | undefined): boolean {
  return pc !== undefined && !pc.stale && pc.host?.state === "connected";
}

/**
 * Whether the open chat `session` was closed on its PC: marked done, or gone from a list its
 * connected host just gave. A PC not listed, a host not connected or a list that failed to read
 * say nothing: the chat stays open through a host restart or a dropped PC.
 */
export function openHostChatClosed(pc: HostPc | undefined, session: string): boolean {
  if (!pc || pc.stale || pc.host?.state !== "connected") {
    return pc?.chats.find((chat) => chat.session === session)?.archived === true;
  }
  const row = pc.chats.find((chat) => chat.session === session);
  return row === undefined || row.archived;
}

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
/**
 * A chat's row as an action of this page left it, until the PC's list says the same: the bridge
 * answers once it has sent the action, and the host's list follows a moment later.
 */
interface RowEdit { change: Partial<HostChatRow> | "gone"; settled: boolean; until: number }
/** How long a settled edit outlives reads that do not show it yet: then the PC's list wins. */
export const ROW_EDIT_MS = 10_000;

const editShown = (row: HostChatRow | undefined, change: RowEdit["change"]): boolean =>
  change === "gone" ? row === undefined : row !== undefined && Object.entries(change).every(([key, value]) => row[key as keyof HostChatRow] === value);

export class HostPcs {
  private pcs: ReadonlyMap<string, HostPc> = new Map();
  /** each PC as its bridge last listed it, before this page's edits */
  private read = new Map<string, HostPc>();
  private readonly edits = new Map<string, Map<string, RowEdit>>();
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
    this.read = new Map([...this.read].filter(([id]) => online.includes(id)));
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
    if (host) {
      const read = this.read.get(machineId);
      // the pushed state comes before its list: until that is read, the chats shown are not its word
      if (read) this.read.set(machineId, { ...read, host, stale: true });
      this.set(withPc(this.pcs, machineId, { host, chats: this.pcs.get(machineId)?.chats ?? [], stale: true }));
    }
    const read = Promise.allSettled([host ? Promise.resolve(host) : fetchHostState(machineId), fetchHostChats(machineId)]).then(([state, chats]) => {
      if (this.generation.get(machineId) !== turn || !this.online.includes(machineId)) return;
      if ((state.status === "rejected" && isHostChatsOff(state.reason)) || (chats.status === "rejected" && isHostChatsOff(chats.reason))) {
        this.off.add(machineId);
        this.read.delete(machineId);
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
      const nextChats = chats.status === "fulfilled" ? newestFirst(chats.value) : down ? [] : this.read.get(machineId)?.chats ?? previous?.chats ?? [];
      this.read.set(machineId, { host: nextHost, chats: nextChats, ...(chats.status === "fulfilled" ? {} : { stale: true as const }) });
      this.show(machineId);
    });
    this.reads.add(read);
    void read.finally(() => this.reads.delete(read));
  }

  rename(machineId: string, session: string, title: string): Promise<void> {
    return this.act(machineId, session, { title }, () => renameHostChat(machineId, session, title));
  }

  /** Mark as read (true) or unread: the row says so at once, and goes back if the PC refuses. */
  setRead(machineId: string, session: string, read: boolean): Promise<void> {
    return this.act(machineId, session, { unread: !read }, () => markHostChatRead(machineId, session, read));
  }

  /**
   * Mark as done (true) or Restore. Shown once the bridge has it: a done chat leaves its tab, and
   * the open one is let go, which a refusal could not undo.
   */
  setArchived(machineId: string, session: string, archived: boolean): Promise<void> {
    return this.act(machineId, session, { archived }, () => archiveHostChat(machineId, session, archived), false);
  }

  /** Deletes the chat; its row goes once the bridge has deleted it (a refusal leaves it be). */
  remove(machineId: string, session: string): Promise<void> {
    return this.act(machineId, session, "gone", () => deleteHostChat(machineId, session), false);
  }

  /**
   * Sends the action and shows `change` on the chat's row: at once when `early` (a refusal then
   * takes it back), else once the bridge has it. A refusal is thrown to the caller, which says so.
   * The row keeps the change until the PC's list shows it too; a later action on it replaces this one.
   */
  private async act(machineId: string, session: string, change: RowEdit["change"], send: () => Promise<unknown>, early = true): Promise<void> {
    const rows = this.edits.get(machineId) ?? new Map<string, RowEdit>();
    this.edits.set(machineId, rows);
    const edit: RowEdit = { change, settled: false, until: 0 };
    // a refusal puts back what was shown before: an earlier edit of this row the list has not caught up with too
    const before = rows.get(session);
    if (early) { rows.set(session, edit); this.show(machineId); }
    try {
      await send();
    } catch (error) {
      if (early && rows.get(session) === edit) { if (before) rows.set(session, before); else rows.delete(session); }
      this.show(machineId);
      throw error;
    }
    if (!early && rows.has(session) && rows.get(session) !== before) return; // a later action has the row
    edit.settled = true;
    edit.until = Date.now() + ROW_EDIT_MS;
    rows.set(session, edit);
    this.show(machineId);
  }

  /** A PC's group: its last read, with the edits it does not show yet laid over it. */
  private show(machineId: string): void {
    const read = this.read.get(machineId) ?? this.pcs.get(machineId);
    if (!read) return;
    const rows = this.edits.get(machineId);
    let chats = read.chats;
    for (const [session, edit] of rows ?? []) {
      const row = chats.find((each) => each.session === session);
      // the PC's list caught up, or had its time: the edit goes
      if (edit.settled && (editShown(row, edit.change) || Date.now() > edit.until)) { rows!.delete(session); continue; }
      if (!row) continue;
      chats = edit.change === "gone" ? chats.filter((each) => each !== row) : chats.map((each) => each === row ? { ...each, ...edit.change as Partial<HostChatRow> } : each);
    }
    this.set(withPc(this.pcs, machineId, { host: read.host, chats, ...(read.stale ? { stale: true as const } : {}) }));
  }

  private set(next: ReadonlyMap<string, HostPc>): void {
    if (next === this.pcs) return;
    this.pcs = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The host chats of every connected PC whose bridge has them (HostPcs, in React). */
export function useHostChats(machines: readonly Machine[]): ReadonlyMap<string, HostPc> {
  return useHostChatPcs(machines).pcs;
}

/** useHostChats, with the tracker whose actions (rename, read, done, delete) edit what it shows. */
export function useHostChatPcs(machines: readonly Machine[]): { pcs: ReadonlyMap<string, HostPc>; tracker: HostPcs } {
  const [tracker] = useState(() => new HostPcs());
  const pcs = useSyncExternalStore(tracker.subscribe, tracker.get);
  const online = useMemo(() => machines.filter((machine) => machine.state === "connected").map((machine) => machine.id), [machines]);
  const roster = online.join("\n");
  useEffect(() => { tracker.setRoster(online); }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => tracker.listen(), [tracker]);
  return { pcs, tracker };
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
