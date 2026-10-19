/**
 * Where a chat's turns come from, for ChatView: a herdr pane's conversation (the pane API, as the
 * chat has always read it), or a host chat on a PC's agent host (lib/hostChats.ts). ChatView pages,
 * remembers its place, finds and draws the same way for both; only the reads and the URLs differ.
 *
 * `key` names the chat for what ChatView keeps of it between mounts (its scroll place, its rows'
 * memory): a pane's is the key the pane's chat has always been kept under (paneStorageId), a host
 * chat's `host:<machine>:<session>`, so a host chat never shares a pane's memory.
 */
import type { HostChatRead } from "../../shared/host-chats.ts";
import { machinePath, paneStorageId } from "../../shared/machines.ts";
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";
import { ApiError, getJson, type ConversationPageQuery } from "./api.ts";
import { fetchHostChat, onHostChatMessage, onHostChatResume, watchHostChat } from "./hostChats.ts";
import type { MachineApi } from "./machineContext.tsx";

export interface ChatSource {
  key: string;
  read(page?: ConversationPageQuery): Promise<ConversationResponse>;
  /** the URL of a picture a turn names by `ref`, for <img src> and the image viewer */
  image(ref: string): string;
  /** a tool call's whole output (a turn carries its first few thousand characters) */
  toolOutput(ref: string, signal?: AbortSignal): Promise<string>;
  /** pane: none (PaneTerminal's conversation-watch); host: the bridge's lease on the chat */
  watch?(enabled: boolean): void;
  /** host: this chat changed (a push), its host came up, or a push may have been missed (resume) */
  onChange?(listener: () => void): () => void;
  /** host: the turns of a subagent's own chat (by its chat URI), for its row opened */
  subagentTurns?(chat: string): Promise<ConversationTurn[]>;
}

/** A herdr pane's chat: the reads ChatView made before there were two sources. */
export function paneSource(machineId: string, paneId: string, api: Pick<MachineApi, "fetchPaneConversation">): ChatSource {
  const query = (ref: string): string => new URLSearchParams({ pane_id: paneId, ref }).toString();
  return {
    key: paneStorageId(machineId, paneId),
    read: (page) => api.fetchPaneConversation(paneId, page),
    image: (ref) => machinePath(machineId, `pane/conversation/image?${query(ref)}`),
    toolOutput: async (ref, signal) => {
      const response = await fetch(machinePath(machineId, `pane/conversation/tool-output?${query(ref)}`), { signal });
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    },
  };
}

/** How often a shown host chat renews the bridge's watch on it; the lease is 90 s. */
export const HOST_WATCH_MS = 30_000;

/** A host chat's source: also what each read said beside its turns, for the screen around the chat. */
export interface HostChatSource extends ChatSource {
  watch(enabled: boolean): void;
  onChange(listener: () => void): () => void;
  /** each read of the chat, as the host said it (its title, prompt, model, agent, busy) */
  onRead(listener: (read: HostChatRead) => void): () => void;
  last(): HostChatRead | null;
}

const changed = (detail: string): ApiError => new ApiError("host-chats/chat", 409, detail, "history_changed");

/**
 * A host chat, read through its PC's bridge. The host keeps one window of a chat's turns, which a
 * read with `before` (its `turnsNextCursor`) grows backwards; ChatView pages a conversation the
 * pane's way: a newest page that starts at a cursor, older pages before it. So each cursor is
 * remembered with the turn the window started at when the host gave it (message_ids: one id per
 * host turn, and each host turn is a user turn and an assistant turn), and:
 *
 * - the newest page (no `from`) starts at the first turn of the window it was first read from, and
 *   keeps starting there while that turn is in the chat: another phone paging the same chat back on
 *   the bridge does not move it. Its cursor is that window's. A window read at the chat's beginning
 *   (no cursor) is anchored on its first turn too, and read again from the new window once it no
 *   longer starts there or gets a cursor (the host restarted and loaded a later page): else the
 *   page would shrink to the new window with nothing older to reach;
 * - `from` a cursor: the turns from where the window started when that cursor was given, the cursor
 *   itself back (no turns to fill in between);
 * - `before` a cursor: only the turns the host put ahead of that start, under its next cursor.
 *
 * A cursor not known, or whose turn the chat no longer has, answers 409 `history_changed`, as a
 * pane's does: ChatView drops the older pages and reads again. Its history is the session.
 */
export function hostSource(machineId: string, session: string): HostChatSource {
  const query = (ref: string): string => new URLSearchParams({ session, ref }).toString();
  /** the turn id each cursor's window started at */
  const starts = new Map<string, string | null>();
  /** where the newest page starts: null before the first read; its first turn's id (null: the chat had none) */
  let newest: { cursor: string | null; id: string | null } | null = null;
  let lastRead: HostChatRead | null = null;
  /** the last newest page answered: an unchanged read hands back this very object (ChatView skips it) */
  let lastPage: { from: string | undefined; signature: string; answer: ConversationResponse } | null = null;
  const readListeners = new Set<(read: HostChatRead) => void>();
  const fetchRead = (before?: string): Promise<HostChatRead> => fetchHostChat(machineId, session, before);
  let holders = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const heard = (read: HostChatRead): void => {
    lastRead = read;
    for (const listener of [...readListeners]) listener(read);
  };
  /** the ids of the host turns the read holds, in order (pending messages come after them) */
  const turnIds = (read: HostChatRead): string[] => (read.message_ids ?? []).slice(0, Math.floor(read.turns.length / 2));
  /** where turn `id` is in the read's turns; null (a chat with no turn yet) is the start */
  const at = (read: HostChatRead, id: string | null): number => id === null ? 0 : turnIds(read).indexOf(id);
  const remember = (read: HostChatRead): void => {
    if (read.cursor !== null) starts.set(read.cursor, turnIds(read)[0] ?? null);
  };
  const answer = (read: HostChatRead, from: number, to: number, cursor: string | null): ConversationResponse => ({
    source: "agent-host",
    history_id: session,
    turns: read.turns.slice(from * 2, to < 0 ? undefined : to * 2),
    cursor,
    metadata: { model: read.model?.id ?? null, reasoning_effort: read.model?.effort ?? null },
  });

  return {
    key: `host:${machineId}:${session}`,
    async read(page = {}) {
      if (page.since !== undefined) throw changed("a host chat has no pages between two cursors");
      if (page.before !== undefined) {
        const start = starts.get(page.before);
        if (start === undefined) throw changed(`no such cursor: ${page.before}`);
        const read = await fetchRead(page.before);
        heard(read);
        const end = at(read, start);
        if (end < 0) throw changed("the chat no longer holds the turn its page started at");
        remember(read);
        return answer(read, 0, end, read.cursor);
      }
      const read = await fetchRead();
      heard(read);
      let from: { cursor: string | null; id: string | null };
      if (page.from !== undefined) {
        const start = starts.get(page.from);
        if (start === undefined || at(read, start) < 0) throw changed(`no such cursor: ${page.from}`);
        from = { cursor: page.from, id: start };
      } else {
        const first = turnIds(read)[0] ?? null;
        const moved = newest === null || newest.id === null || at(read, newest.id) < 0
          // anchored at the chat's beginning: the window must still start there, with no cursor
          || (newest.cursor === null && (read.cursor !== null || first !== newest.id));
        if (moved || newest === null) {
          remember(read);
          newest = { cursor: read.cursor, id: first };
        }
        from = newest;
      }
      if (lastPage !== null && lastPage.from === page.from && lastPage.signature === read.signature && lastPage.answer.cursor === from.cursor) return lastPage.answer;
      const shown = answer(read, at(read, from.id), -1, from.cursor);
      lastPage = { from: page.from, signature: read.signature, answer: shown };
      return shown;
    },
    image: (ref) => machinePath(machineId, `host-chats/image?${query(ref)}`),
    // the read route takes a subagent's chat URI as its `session` once this chat's read found it
    subagentTurns: async (chat) => (await fetchHostChat(machineId, chat)).turns,
    toolOutput: async (ref, signal) => (await getJson<{ output: string }>(machinePath(machineId, `host-chats/tool-output?${query(ref)}`), { signal })).output,
    // one lease however many hold it (StrictMode mounts an effect twice): asked at once, renewed
    // every 30 s; a chat no longer shown lets it run out
    watch(enabled) {
      holders = Math.max(0, holders + (enabled ? 1 : -1));
      if (holders > 0 && timer === undefined) {
        const renew = (): void => { void watchHostChat(machineId, session).catch(() => undefined); };
        renew();
        timer = setInterval(renew, HOST_WATCH_MS);
      } else if (holders === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    onChange(listener) {
      const stops = [
        onHostChatMessage((from, pushed) => {
          if (from !== machineId) return;
          if (pushed.type === "host-chat-changed" ? pushed.session === session : pushed.host.state === "connected") listener();
        }),
        // back on screen, or the event stream reopened: a push may have been missed meanwhile
        onHostChatResume(listener),
      ];
      return () => { for (const stop of stops) stop(); };
    },
    onRead(listener) {
      readListeners.add(listener);
      return () => { readListeners.delete(listener); };
    },
    last: () => lastRead,
  };
}
