/**
 * One host chat, read from its PC's agent host through the bridge (lib/hostChats.ts): its turns in
 * the app's ChatView, the question or approval it waits on in the prompt card's look, and the app's
 * Composer, with VS Code's send menu (steer, queue, stop and send), the messages waiting for the
 * running turn, and two pills that pick the next message's model and effort, and its agent.
 *
 * The transcript is the app's ChatView, reading the chat through its host source
 * (lib/chatSource.ts): the read when it opens, a re-read on each `host-chat-changed` push for it and
 * on resume, the bridge's watch (a 90 s lease, renewed every 30 s while shown), and earlier pages.
 * Every read the source makes is handed here too, for the title, the prompt card and the pills.
 * A message goes out once, on the user's tap: a send that fails leaves its text in the box and says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import "./ChatView.css";
import "./ChatTimeline.css";
import "./Composer.css";
import "./HostChatView.css";

import type { HostAgent, HostChatRead, HostModel } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { hostSource } from "../lib/chatSource.ts";
import {
  agentName, answerHost, choose, chosenFor, confirmHost, errorText, fetchHostModels, hostDraftKey, removeHostPending,
  sendErrorText, sendHost, setHostDraftModel, settleChoice, stopHost, type HostChoice,
} from "../lib/hostChats.ts";
import type { HostSendPick } from "../lib/compose.ts";
import { Composer } from "./Composer.tsx";
import { AgentMark } from "./AgentMark.tsx";
import { ChatView } from "./ChatView.tsx";
import { PromptCardView, type PromptChoice } from "./PromptCard.tsx";
import { VscodePickerSheet } from "./VscodePickerSheet.tsx";

export interface HostChatViewProps { machineId: string; session: string }

type HostPrompt = NonNullable<HostChatRead["prompt"]>;

/**
 * The chat's question or tool approval, in the pane prompt card's markup and CSS (PromptCardView),
 * answered through the host: a question by its option ids (the typed answer as text), an approval
 * by whether the picked option approves, with the host's own option id when it offered one.
 */
export function HostPromptCard({ machineId, session, prompt, onPromptChanged, onAnswered }: {
  machineId: string; session: string; prompt: HostPrompt; onPromptChanged(): void; onAnswered(): void;
}) {
  const submit = async (choice: PromptChoice): Promise<void> => {
    const ref = prompt.host;
    if ("request_id" in ref) {
      const picked = choice.option_indices ?? (choice.option_index !== undefined ? [choice.option_index] : []);
      // a typed answer names the "Other…" slot, whose host id is empty: the text goes as freeformValues
      const typed = choice.custom_text !== undefined && prompt.custom_option_index !== null ? [ref.option_ids[prompt.custom_option_index] ?? ""] : [];
      const optionIds = [...picked.map((index) => ref.option_ids[index] ?? "").filter((id) => id !== ""), ...typed];
      await answerHost(machineId, {
        session, request_id: ref.request_id, question_id: ref.question_id,
        ...(optionIds.length > 0 ? { option_ids: optionIds } : {}),
        ...(choice.custom_text !== undefined ? { text: choice.custom_text } : {}),
      });
      return;
    }
    const index = choice.option_index ?? 0;
    const optionId = ref.option_ids[index] ?? "";
    await confirmHost(machineId, {
      session, turn_id: ref.turn_id, tool_call_id: ref.tool_call_id, approved: ref.approves[index] === true,
      ...(optionId !== "" ? { option_id: optionId } : {}),
    });
  };
  return <PromptCardView prompt={prompt} submit={submit} onPromptChanged={onPromptChanged} onAnswered={onAnswered} markdown />;
}

export function HostChatView({ machineId, session }: HostChatViewProps) {
  const t = useT();
  // the chat's reads, its watch and its pushes: one source for as long as this chat is open
  const source = useMemo(() => hostSource(machineId, session), [machineId, session]);
  const [chat, setChat] = useState<HostChatRead | null>(() => source.last());
  // bumped to read the chat again now (a send, an answer); `sent` also tells the chat a message went
  const [refresh, setRefresh] = useState(0);
  const [sent, setSent] = useState(0);
  const reread = (): void => setRefresh((key) => key + 1);
  const [choice, setChoice] = useState<HostChoice>(() => chosenFor(machineId, session));
  const [joined, setJoined] = useState(false);
  const [sheet, setSheet] = useState<"model" | "agent" | null>(null);
  const [catalog, setCatalog] = useState<{ models: HostModel[]; agents: HostAgent[] } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // what each read says beside the turns; an unchanged one keeps the object shown
  useEffect(() => source.onRead((next) => {
    if (mounted.current) setChat((current) => current !== null && current.signature === next.signature ? current : next);
  }), [source]);

  const busy = chat?.busy === true;
  const status = chat?.prompt ? "blocked" : busy ? "working" : "idle";

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
      void fetchHostModels(machineId, session).then((value) => { if (mounted.current) setCatalog(value); }, (cause: unknown) => {
        if (mounted.current) { setSheetError(errorText(cause)); setCatalog({ models: [], agents: [] }); }
      });
    }
  };
  // the models' names are the pills' too: read once the chat is
  useEffect(() => {
    if (chat === null || catalog !== null) return;
    void fetchHostModels(machineId, session).then((value) => { if (mounted.current) setCatalog((current) => current ?? value); }, () => undefined);
  }, [chat === null, catalog, machineId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // a pick the chat now uses is the chat's own from here on
  useEffect(() => {
    if (chat !== null) setChoice(settleChoice(machineId, session, { model: chat.model, agent: chat.agent }));
  }, [chat, machineId, session]);

  const pickModel = (next: { id: string; effort?: string }): void => {
    choose(machineId, session, { model: next });
    setChoice(chosenFor(machineId, session));
    setSheetError(null);
    void setHostDraftModel(machineId, session, next).catch((cause: unknown) => { if (mounted.current) setSheetError(errorText(cause)); });
    // a model with an effort to pick keeps the sheet open for it
    const entry = catalog?.models.find((each) => each.id === next.id);
    if (!entry?.efforts || next.effort !== undefined) setSheet(null);
  };
  const pickAgent = (next: string | null): void => {
    choose(machineId, session, { agent: next });
    setChoice(chosenFor(machineId, session));
    setSheet(null);
  };

  // One message, once, on the user's tap, as `mode`. True: it went (the composer clears what it
  // carried); a string: it did not, and says why (the words stay in the box).
  const sendAs = useCallback(async (mode: HostSendPick | "send", text: string): Promise<boolean | string> => {
    const words = text.trim();
    try {
      // sent: sendHost lets the stored draft go even if this screen is gone by now
      const result = await sendHost(machineId, { session, text: words, ...(mode === "send" ? {} : { mode }) }, { model: chat?.model ?? null, agent: chat?.agent ?? null }, true);
      if (mounted.current) {
        setJoined(result.joined === true);
        // the chat reads it now (and follows it to the end); the pills let a pick go only once the
        // read names it as the chat's last
        setSent((key) => key + 1);
        reread();
      }
      return true;
    } catch (cause) {
      return sendErrorText(cause, t);
    }
  }, [chat?.agent, chat?.model, machineId, session, t]);
  useEffect(() => { if (!busy) setJoined(false); }, [busy]);
  const sendMenu = useMemo(() => ({ default: "steer" as const, onPick: (mode: HostSendPick, text: string) => sendAs(mode, text) }), [sendAs]);

  const label = t("Copilot chat {title}", { title: chat?.title ?? "" });
  const pills = <span className="host-chat-pills">
    <button type="button" className="composer-pill host-chat-pill host-chat-model" aria-haspopup="dialog" aria-expanded={sheet === "model"} aria-label={t("Model: {model}", { model: model?.effort ? `${modelLabel} · ${model.effort}` : modelLabel })} onClick={() => openSheet("model")}>
      <span className={`composer-model${model === null ? " is-none" : modelEntry ? "" : " is-id"}`}>{modelLabel}</span>
      {model?.effort && <span className="composer-reasoning"><span className="composer-reasoning-dot" aria-hidden="true">·</span><span className="composer-reasoning-short">{model.effort}</span></span>}
      <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
    </button>
    <button type="button" className="composer-pill host-chat-pill host-chat-agent" aria-haspopup="dialog" aria-expanded={sheet === "agent"} aria-label={t("Agent: {agent}", { agent: agentLabel })} onClick={() => openSheet("agent")}>
      <span className="composer-model">{agentLabel}</span>
      <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
    </button>
  </span>;

  return <div className="terminal-stack is-chat host-chat" data-host-session={session}>
    <p className="host-chat-title"><AgentMark agent="copilot" size={16} /><span>{chat?.title.trim() || t("Copilot chat")}</span></p>
    <div className="terminal-surface">
      {/* the app's chat, read from the host: no pane, no terminal, no scrollback (ChatView's source) */}
      <ChatView paneId="" source={source} label={label} refreshKey={refresh} sentKey={sent}
        connected ended={false} agent="vscode" agentStatus={status} />
    </div>
    <div className="prompt-dock" aria-live="polite">
      {chat?.prompt && <HostPromptCard key={chat.prompt.id} machineId={machineId} session={session} prompt={chat.prompt} onPromptChanged={reread} onAnswered={() => {
        setChat((current) => current === null ? current : { ...current, prompt: null });
        reread();
      }} />}
    </div>
    <Composer key={session} paneId="" connected agent="copilot" agentStatus={status} autoFocus={false}
      draftKey={hostDraftKey(machineId, session)} noMenus keywords={catalog?.agents.map((each) => each.name) ?? []}
      pills={pills} sendMenu={sendMenu}
      pending={chat?.pending ?? []} onRemovePending={(id) => { void removeHostPending(machineId, session, id).finally(reread); }}
      pendingNote={joined ? t("Added to your steer") : null}
      onSend={(text) => sendAs("send", text)}
      onAbort={() => { void stopHost(machineId, session).finally(reread); }} />
    {sheet !== null && <VscodePickerSheet focus={sheet} models={catalog?.models ?? null} agents={catalog?.agents ?? null} model={model} agent={agent} error={sheetError}
      onModel={pickModel} onAgent={pickAgent} onClose={() => setSheet(null)} />}
  </div>;
}
