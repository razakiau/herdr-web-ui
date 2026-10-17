/**
 * One VS Code chat, read from its PC's agent host through the bridge (lib/vscodeChats.ts): its
 * turns in the chat's own rows (ChatView's Turn inside ChatTimeline), the question or approval it
 * waits on in the prompt card's look, and a composer whose two pills pick the next message's model
 * and effort, and its agent (VscodePickerSheet).
 *
 * The screen reads the chat when it opens and on each `vscode-chat-changed` push for it, and keeps
 * the bridge watching it (a 90 s lease, renewed every 30 s while the page is shown). A message goes
 * out once, on the user's tap: a send that fails leaves its text in the box and says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, LoaderCircle } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";

import "./ChatView.css";
import "./ChatTimeline.css";
import "./Composer.css";
import "./VscodeChatView.css";

import type { ConversationTurn } from "../../shared/protocol.ts";
import type { VscodeAgent, VscodeChatRead, VscodeModel } from "../../shared/vscode.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { usePageVisible } from "../lib/visibility.ts";
import type { ChatRowMemory } from "../lib/chatRowState.tsx";
import {
  answerVscode, choose, chosenFor, confirmVscode, fetchVscodeChat, fetchVscodeModels, onVscodeMessage, sendVscode,
  setVscodeDraftModel, watchVscodeChat, type VscodeChoice,
} from "../lib/vscodeChats.ts";
import { AgentMark } from "./AgentMark.tsx";
import { Turn } from "./ChatView.tsx";
import { loadChatTimeline, useChatTimeline } from "./chatTimelineLoader.ts";
import { PromptCardView, type PromptChoice } from "./PromptCard.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { VscodePickerSheet } from "./VscodePickerSheet.tsx";

/** How often the screen renews the bridge's watch on the chat; the lease is 90 s. */
const WATCH_MS = 30_000;
/** Scrolling this close to the top asks for the turns before. */
const LOAD_OLDER_PX = 400;

export interface VscodeChatViewProps { machineId: string; session: string }

interface Row { key: string; beforeUser: boolean; turn: ConversationTurn }

const draftKey = (machineId: string, session: string): string => `herdr-web-ui:vscode-draft:${machineId}:${session}`;

function readDraft(machineId: string, session: string): string {
  try { return window.sessionStorage.getItem(draftKey(machineId, session)) ?? ""; } catch { return ""; }
}

function keepDraft(machineId: string, session: string, text: string): void {
  try {
    if (text === "") window.sessionStorage.removeItem(draftKey(machineId, session));
    else window.sessionStorage.setItem(draftKey(machineId, session), text);
  } catch { /* the box still holds it */ }
}

const message = (cause: unknown): string => cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);

/** An agent's name from its file's uri (`…/Report.agent.md` → Report), for an agent the list does not name. */
function agentName(uri: string): string {
  const file = decodeURIComponent(uri.split("/").pop() ?? uri);
  return file.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "") || uri;
}

type VscodePrompt = NonNullable<VscodeChatRead["prompt"]>;

/**
 * The chat's question or tool approval, in the pane prompt card's markup and CSS (PromptCardView),
 * answered through the host: a question by its option ids (the typed answer as text), an approval
 * by whether the picked option approves, with the host's own option id when it offered one.
 */
export function VscodePromptCard({ machineId, session, prompt, onPromptChanged, onAnswered }: {
  machineId: string; session: string; prompt: VscodePrompt; onPromptChanged(): void; onAnswered(): void;
}) {
  const submit = async (choice: PromptChoice): Promise<void> => {
    const ref = prompt.vscode;
    if ("request_id" in ref) {
      const picked = choice.option_indices ?? (choice.option_index !== undefined ? [choice.option_index] : []);
      const optionIds = picked.map((index) => ref.option_ids[index] ?? "").filter((id) => id !== "");
      await answerVscode(machineId, {
        session, request_id: ref.request_id, question_id: ref.question_id,
        ...(optionIds.length > 0 ? { option_ids: optionIds } : {}),
        ...(choice.custom_text !== undefined ? { text: choice.custom_text } : {}),
      });
      return;
    }
    const index = choice.option_index ?? 0;
    const optionId = ref.option_ids[index] ?? "";
    await confirmVscode(machineId, {
      session, turn_id: ref.turn_id, tool_call_id: ref.tool_call_id, approved: ref.approves[index] === true,
      ...(optionId !== "" ? { option_id: optionId } : {}),
    });
  };
  return <PromptCardView prompt={prompt} submit={submit} onPromptChanged={onPromptChanged} onAnswered={onAnswered} />;
}

export function VscodeChatView({ machineId, session }: VscodeChatViewProps) {
  const t = useT();
  const { settings } = useSettings();
  const visible = usePageVisible();
  const ChatTimeline = useChatTimeline();
  const [chat, setChat] = useState<VscodeChatRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
  const [choice, setChoice] = useState<VscodeChoice>(() => chosenFor(machineId, session));
  const [text, setText] = useState(() => readDraft(machineId, session));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [sheet, setSheet] = useState<"model" | "agent" | null>(null);
  const [catalog, setCatalog] = useState<{ models: VscodeModel[]; agents: VscodeAgent[] } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const following = useRef(true);
  const memories = useMemo(() => new Map<string, ChatRowMemory>(), []);
  // the row keys: the turn's place counted from the first one read, so a page of older turns
  // takes keys of its own and the rows already drawn keep theirs
  const base = useRef(0);
  const count = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const apply = useCallback((next: VscodeChatRead, older: boolean): void => {
    if (older) base.current -= Math.max(0, next.turns.length - count.current);
    count.current = next.turns.length;
    setChat((current) => current !== null && current.signature === next.signature ? current : next);
    setError(null);
  }, []);

  const read = useCallback(async (): Promise<void> => {
    const turn = ++generation.current;
    try {
      const next = await fetchVscodeChat(machineId, session);
      if (mounted.current && turn === generation.current) apply(next, false);
    } catch (cause) {
      if (mounted.current && turn === generation.current) setError(message(cause));
    }
  }, [machineId, session, apply]);

  useEffect(() => {
    void loadChatTimeline().catch(() => undefined);
    void read();
    return onVscodeMessage((from, pushed) => {
      if (from !== machineId) return;
      if (pushed.type === "vscode-chat-changed" ? pushed.session === session : pushed.host.state === "connected") void read();
    });
  }, [machineId, session, read]);

  // the bridge watches the chat while it is on screen; a closed tab lets the lease run out
  useEffect(() => {
    if (!visible) return;
    const renew = (): void => { void watchVscodeChat(machineId, session).catch(() => undefined); };
    renew();
    const timer = window.setInterval(renew, WATCH_MS);
    return () => window.clearInterval(timer);
  }, [machineId, session, visible]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const cursor = chat?.cursor;
    if (!cursor || olderState === "loading") return;
    setOlderState("loading");
    const turn = ++generation.current;
    try {
      const next = await fetchVscodeChat(machineId, session, cursor);
      if (!mounted.current) return;
      if (turn === generation.current) apply(next, true);
      setOlderState("idle");
    } catch {
      if (mounted.current) setOlderState("failed");
    }
  }, [chat?.cursor, olderState, machineId, session, apply]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 48;
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  };

  const turns = chat?.turns ?? [];
  const rows = useMemo<Row[]>(() => turns.map((turn, index) => ({
    key: `${base.current + index}`,
    turn,
    beforeUser: turn.role === "assistant" && turns[index + 1]?.role === "user",
  })), [turns]);
  const busy = chat?.busy === true;
  const status = chat?.prompt ? "blocked" : busy ? "working" : "idle";
  const renderRow = useCallback((row: Row, index: number) => {
    const live = index === rows.length - 1 && row.turn.role === "assistant" && status !== "idle";
    return <RenderBoundary resetKey={row.turn} fallback={() => <p className="chat-inline-state chat-inline-error">{t("This message can't be shown here.")}</p>}>
      <Turn paneId="" turn={row.turn} live={live} waiting={live && status === "blocked"} showThinking={settings.showThinking} />
    </RenderBoundary>;
  }, [rows.length, status, settings.showThinking, t]);

  // what the next message carries: the phone's pick, else what the chat used last
  const model = choice.model ? { id: choice.model.id, effort: choice.model.effort ?? null } : chat?.model ?? null;
  const agent = "agent" in choice ? choice.agent ?? null : chat?.agent ?? null;
  const modelEntry = catalog?.models.find((each) => each.id === model?.id);
  const modelLabel = model === null ? t("Model —") : modelEntry?.name ?? model.id;
  const agentLabel = agent === null ? t("Agent") : catalog?.agents.find((each) => each.uri === agent)?.name ?? agentName(agent);

  const openSheet = (part: "model" | "agent"): void => {
    setSheet(part);
    setSheetError(null);
    if (catalog === null) {
      void fetchVscodeModels(machineId, session).then((value) => { if (mounted.current) setCatalog(value); }, (cause: unknown) => {
        if (mounted.current) { setSheetError(message(cause)); setCatalog({ models: [], agents: [] }); }
      });
    }
  };
  // the models' names are the pills' too: read once the chat is
  useEffect(() => {
    if (chat === null || catalog !== null) return;
    void fetchVscodeModels(machineId, session).then((value) => { if (mounted.current) setCatalog((current) => current ?? value); }, () => undefined);
  }, [chat === null, catalog, machineId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickModel = (next: { id: string; effort?: string }): void => {
    choose(machineId, session, { model: next });
    setChoice(chosenFor(machineId, session));
    setSheetError(null);
    void setVscodeDraftModel(machineId, session, next).catch((cause: unknown) => { if (mounted.current) setSheetError(message(cause)); });
    // a model with an effort to pick keeps the sheet open for it
    const entry = catalog?.models.find((each) => each.id === next.id);
    if (!entry?.efforts || next.effort !== undefined) setSheet(null);
  };
  const pickAgent = (next: string | null): void => {
    choose(machineId, session, { agent: next });
    setChoice(chosenFor(machineId, session));
    setSheet(null);
  };

  const send = async (): Promise<void> => {
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await sendVscode(machineId, { session, text: words });
      if (!mounted.current) return;
      setText("");
      keepDraft(machineId, session, "");
      setChoice(chosenFor(machineId, session));
      setQueued(result.queued);
      following.current = true;
      void read();
    } catch (cause) {
      // once, by the user's tap: the words stay in the box for the next one
      if (mounted.current) setSendError(message(cause));
    }
    if (mounted.current) setSending(false);
  };
  useEffect(() => { if (!busy) setQueued(false); }, [busy]);


  const header = <>
    <p className="vscode-chat-title"><AgentMark agent="vscode" size={16} /><span>{chat?.title.trim() || t("VS Code chat")}</span></p>
    {chat?.cursor && (
      <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading"} onClick={() => void loadOlder()}>
        {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
      </button>
    )}
    {chat !== null && chat.cursor === null && base.current < 0 && <p className="chat-endcap">{t("beginning of conversation")}</p>}
  </>;
  const footer = <>
    {error !== null && <p className="chat-inline-state chat-inline-error" role="alert">{error}</p>}
    {chat === null && error === null && <p className="chat-inline-state" role="status">{t("Loading conversation…")}</p>}
    {chat !== null && turns.length === 0 && chat.prompt === null && <div className="chat-empty"><AgentMark agent="vscode" size={32} /><p>{t("No conversation yet — say something below")}</p></div>}
  </>;
  const label = t("VS Code chat {title}", { title: chat?.title ?? "" });
  const statusLine = sendError !== null ? null : queued ? t("Queued: it goes out when this turn ends") : busy ? t("VS Code is working on this chat; Send queues the message") : null;

  return <div className="terminal-stack is-chat vscode-chat" data-vscode-session={session}>
    <div className="terminal-surface">
      <div className="chat-frame"><div className="chat-frame-body">
        {ChatTimeline === null
          ? <div className="chat-view chat-view-virtual" role="log" aria-label={label}>
            <div className="chat-transcript chat-transcript-virtual">
              <div className="chat-virtual-header">{header}</div>
              <div className="chat-virtual-footer">{footer}</div>
            </div>
          </div>
          : <ChatTimeline rows={rows} scope={`${machineId}\n${session}`} source={undefined} scroller={scroller} listRef={listRef} following={following}
            smoothFollow={false} memories={memories} header={header} footer={footer} label={label} onScroll={onScroll} renderRow={renderRow} />}
      </div></div>
    </div>
    <div className="prompt-dock" aria-live="polite">
      {chat?.prompt && <VscodePromptCard key={chat.prompt.id} machineId={machineId} session={session} prompt={chat.prompt} onPromptChanged={() => void read()} onAnswered={() => {
        setChat((current) => current === null ? current : { ...current, prompt: null });
        void read();
      }} />}
    </div>
    <div className="composer vscode-composer" role="group" aria-label={t("Message composer")}>
      {statusLine !== null && <p className="vscode-chat-status" role="status" data-status={queued ? "queued" : "working"}>{statusLine}</p>}
      {sendError !== null && <p className="composer-note vscode-chat-error" role="alert"><span className="composer-note-text">{t("Not sent: {error}", { error: sendError })}</span></p>}
      <div className="composer-surface">
        <textarea className="composer-text" rows={1} value={text} placeholder={t("Message VS Code")} aria-label={t("Message")} spellCheck autoCapitalize="sentences" autoCorrect="on"
          onChange={(event) => { setText(event.target.value); keepDraft(machineId, session, event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !window.matchMedia?.("(pointer: coarse)").matches) {
              event.preventDefault();
              void send();
            }
          }} />
        <div className="composer-controls composer-controls-left vscode-chat-pills">
          <button type="button" className="composer-pill vscode-chat-pill vscode-chat-model" aria-haspopup="dialog" aria-expanded={sheet === "model"} aria-label={t("Model: {model}", { model: model?.effort ? `${modelLabel} · ${model.effort}` : modelLabel })} onClick={() => openSheet("model")}>
            <span className={`composer-model${model === null ? " is-none" : modelEntry ? "" : " is-id"}`}>{modelLabel}</span>
            {model?.effort && <span className="composer-reasoning"><span className="composer-reasoning-dot" aria-hidden="true">·</span><span className="composer-reasoning-short">{model.effort}</span></span>}
            <ChevronDown className="vscode-chat-pill-caret" aria-hidden="true" />
          </button>
          <button type="button" className="composer-pill vscode-chat-pill vscode-chat-agent" aria-haspopup="dialog" aria-expanded={sheet === "agent"} aria-label={t("Agent: {agent}", { agent: agentLabel })} onClick={() => openSheet("agent")}>
            <span className="composer-model">{agentLabel}</span>
            <ChevronDown className="vscode-chat-pill-caret" aria-hidden="true" />
          </button>
        </div>
        <div className="composer-controls composer-controls-right">
          <button type="button" className="composer-action composer-send" aria-label={busy ? t("Queue message") : t("Send message")} title={sending ? t("Sending…") : busy ? t("Queue message") : t("Send message")}
            aria-busy={sending || undefined} disabled={sending || text.trim().length === 0}
            onPointerDown={(event) => event.preventDefault()} onClick={() => void send()}>
            {sending ? <LoaderCircle className="composer-send-progress" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
    {sheet !== null && <VscodePickerSheet focus={sheet} models={catalog?.models ?? null} agents={catalog?.agents ?? null} model={model} agent={agent} error={sheetError}
      onModel={pickModel} onAgent={pickAgent} onClose={() => setSheet(null)} />}
  </div>;
}
