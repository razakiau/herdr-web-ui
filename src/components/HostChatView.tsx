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
import { ChevronDown, ListChecks, MessageSquare, Rocket, ShieldCheck } from "lucide-react";

import "./ChatView.css";
import "./ChatTimeline.css";
import "./Composer.css";
import "./HostChatView.css";

import type { HostAgent, HostChatRead, HostModel, HostSessionConfig } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { hostSource } from "../lib/chatSource.ts";
import {
  agentName, answerHost, answerHostForm, choose, chosenFor, confirmHost, errorText, fetchHostConfig, fetchHostFiles, fetchHostModels, hostDraftKey, removeHostPending,
  sendErrorText, sendHost, setHostConfig, uploadHostFile, setHostDraftModel, settleChoice, stopHost, type HostChoice,
} from "../lib/hostChats.ts";
import type { HostSendPick } from "../lib/compose.ts";
import { Composer, type SentAttachment } from "./Composer.tsx";
import { HostChatStatus } from "./HostChatStatus.tsx";
import { ChatView } from "./ChatView.tsx";
import { PromptCardView, type PromptChoice } from "./PromptCard.tsx";
import { APPROVALS_LABEL, MODE_LABEL, ModelMarkIcon, ModelPicker } from "./ModelPicker.tsx";
import { providerMark, rowDetail, shortModelName } from "../lib/modelProvider.ts";
import { hostSlashItems, resolveHostSlash } from "../lib/hostSlash.ts";

export interface HostChatViewProps {
  machineId: string; session: string;
  /** the chat's title as its reads give it: the header's, before the PC's list has the chat */
  onTitle?(title: string): void;
}

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
      if (choice.form && ref.form) {
        const answers = Object.fromEntries(ref.form.map((each, index) => {
          const entry = choice.form?.[index] ?? null;
          const custom = prompt.form?.[index]?.custom_option_index ?? null;
          if (entry === null) return [each.question_id, null];
          const picked = entry.option_indices.map((at) => each.option_ids[at] ?? "").filter((id) => id !== "");
          // typed words name the "Other…" slot, whose host id is empty: the text goes as freeformValues
          const typed = entry.custom_text !== undefined && custom !== null ? [each.option_ids[custom] ?? ""] : [];
          return [each.question_id, { ...(picked.length + typed.length > 0 ? { option_ids: [...picked, ...typed] } : {}), ...(entry.custom_text !== undefined ? { text: entry.custom_text } : {}) }];
        }));
        await answerHostForm(machineId, { session, request_id: ref.request_id, answers });
        return;
      }
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
  return <PromptCardView prompt={prompt} submit={submit} onPromptChanged={onPromptChanged} onAnswered={onAnswered} markdown expandable
    onUploadFile={(file) => uploadHostFile(machineId, session, file)} />;
}

export function HostChatView({ machineId, session, onTitle }: HostChatViewProps) {
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
  const [sheet, setSheet] = useState<"model" | "agent" | "mode" | null>(null);
  const [config, setConfig] = useState<HostSessionConfig | null>(null);
  const [catalog, setCatalog] = useState<{ models: HostModel[]; agents: HostAgent[] } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;
  const readTitle = chat?.title ?? null;
  useEffect(() => { if (readTitle !== null) titleRef.current?.(readTitle); }, [readTitle]);
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

  // the chat's mode and permissions, as its host has them: read with each read of the chat, so a
  // change made in VS Code shows here
  useEffect(() => {
    if (chat === null) return;
    void fetchHostConfig(machineId, session).then((value) => { if (mounted.current) setConfig((current) => JSON.stringify(current) === JSON.stringify(value) ? current : value); }, () => undefined);
  }, [chat, machineId, session]);
  const pickConfig = (change: { mode?: string; approvals?: string }): void => {
    setSheetError(null);
    setConfig((current) => current === null ? current : { ...current, ...(change.mode ? { mode: change.mode } : {}), ...(change.approvals ? { approvals: change.approvals } : {}) });
    setSheet(null);
    void setHostConfig(machineId, session, change).then(() => fetchHostConfig(machineId, session)).then((value) => { if (mounted.current) setConfig(value); }, (cause: unknown) => {
      if (!mounted.current) return;
      setSheetError(errorText(cause));
      void fetchHostConfig(machineId, session).then((value) => { if (mounted.current) setConfig(value); }, () => undefined);
    });
  };

  const openSheet = (part: "model" | "agent" | "mode"): void => {
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
    // the row picks; its effort is the row's right side (ModelPicker), so a pick is done
    setSheet(null);
  };
  const pickAgent = (next: string | null): void => {
    choose(machineId, session, { agent: next });
    setChoice(chosenFor(machineId, session));
    setSheet(null);
  };

  // One message, once, on the user's tap, as `mode`. True: it went (the composer clears what it
  // carried); a string: it did not, and says why (the words stay in the box).
  const sendAs = useCallback(async (mode: HostSendPick | "send", text: string, attached: SentAttachment[] = []): Promise<boolean | string> => {
    // a leading config command (/plan, /autopilot on…) sets the chat's mode or approvals first, as
    // VS Code does on send; what is left goes as the message, and nothing goes when nothing is left
    const slash = resolveHostSlash(text.trim());
    const words = slash ? slash.text : text.trim();
    try {
      if (slash) {
        await setHostConfig(machineId, session, { ...(slash.config["mode"] ? { mode: slash.config["mode"] } : {}), ...(slash.config["autoApprove"] ? { approvals: slash.config["autoApprove"] } : {}) });
        if (mounted.current) void fetchHostConfig(machineId, session).then((value) => { if (mounted.current) setConfig(value); }, () => undefined);
        if (words === "" && attached.length === 0) return true;
      }
      // sent: sendHost lets the stored draft go even if this screen is gone by now
      const result = await sendHost(machineId, { session, text: words, ...(mode === "send" ? {} : { mode }), ...(attached.length > 0 ? { attachments: attached } : {}) }, { model: chat?.model ?? null, agent: chat?.agent ?? null }, true);
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
  const hostMenus = useMemo(() => ({
    slash: (query: string) => hostSlashItems(query, chat?.commands ?? [], config ? { mode: config.mode, approvals: config.approvals } : null),
    files: (query: string) => fetchHostFiles(machineId, session, query),
  }), [chat?.commands, config, machineId, session]);
  useEffect(() => { if (!busy) setJoined(false); }, [busy]);
  const sendMenu = useMemo(() => ({ default: "steer" as const, onPick: (mode: HostSendPick, text: string, attached?: SentAttachment[]) => sendAs(mode, text, attached) }), [sendAs]);

  const label = t("Copilot chat {title}", { title: chat?.title ?? "" });
  const modeLabel = config?.mode ? t(MODE_LABEL[config.mode] ?? config.mode) : null;
  const approvalsLabel = config?.approvals ? t(APPROVALS_LABEL[config.approvals] ?? config.approvals) : null;
  const detail = modelEntry ? rowDetail(modelEntry, model?.effort ?? null) : model?.effort ?? "";
  // VS Code's input toolbar: quiet triggers that say what the next message goes with, each opening its picker
  const effortLabel = model?.effort ? model.effort.charAt(0).toUpperCase() + model.effort.slice(1) : null;
  const ModeIcon = config?.mode === "plan" ? ListChecks : config?.mode === "autopilot" ? Rocket : MessageSquare;
  const approvalsRaised = config?.approvals !== null && config?.approvals !== undefined && config.approvals !== "default";
  const pills = <span className="host-chat-pills">
    <button type="button" className="host-chat-pill host-chat-model" aria-haspopup="dialog" aria-expanded={sheet === "model"}
      aria-label={t("Model: {model}", { model: detail ? `${modelLabel} · ${detail}` : modelLabel })} title={detail ? `${modelLabel} · ${detail}` : modelLabel} onClick={() => openSheet("model")}>
      {modelEntry && <ModelMarkIcon mark={providerMark(modelEntry)} size={14} />}
      <span className={`host-chat-pill-label${model === null ? " is-none" : modelEntry ? "" : " is-id"}`}>{modelEntry ? shortModelName(modelEntry) : modelLabel}</span>
      {effortLabel && <span className="host-chat-pill-aside">{effortLabel}</span>}
      <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
    </button>
    <button type="button" className="host-chat-pill host-chat-agent" aria-haspopup="dialog" aria-expanded={sheet === "agent"} aria-label={t("Agent: {agent}", { agent: agentLabel })} onClick={() => openSheet("agent")}>
      <span className="host-chat-pill-label">{agentLabel}</span>
      <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
    </button>
    {(modeLabel !== null || approvalsLabel !== null) && <button type="button" className="host-chat-pill host-chat-mode" aria-haspopup="dialog" aria-expanded={sheet === "mode"}
      data-approvals={config?.approvals ?? undefined} title={[modeLabel, approvalsLabel].filter(Boolean).join(" · ")}
      aria-label={t("Pick Mode and Permissions, {0}, {1}", { 0: modeLabel ?? "—", 1: approvalsLabel ?? "—" })} onClick={() => openSheet("mode")}>
      <ModeIcon className="host-chat-pill-icon" aria-hidden="true" />
      {modeLabel && <span className="host-chat-pill-label">{modeLabel}</span>}
      {/* Manual is the default and says nothing; a raised level is named, as VS Code's summary does */}
      {approvalsRaised && <>
        <ShieldCheck className="host-chat-pill-shield" aria-hidden="true" />
        <span className="host-chat-pill-aside is-raised">{approvalsLabel}</span>
      </>}
      <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
    </button>}
  </span>;

  return <div className="terminal-stack is-chat host-chat" data-host-session={session}>
    <div className="terminal-surface">
      {/* the app's chat, read from the host: no pane, no terminal, no scrollback (ChatView's source) */}
      <ChatView paneId="" source={source} label={label} refreshKey={refresh} sentKey={sent}
        connected ended={false} agent="copilot" agentStatus={status} />
    </div>
    <div className="prompt-dock" aria-live="polite">
      {chat?.prompt && <HostPromptCard key={chat.prompt.id} machineId={machineId} session={session} prompt={chat.prompt} onPromptChanged={reread} onAnswered={() => {
        setChat((current) => current === null ? current : { ...current, prompt: null });
        reread();
      }} />}
    </div>
    <HostChatStatus read={chat} open={contextOpen} onOpen={() => setContextOpen(true)} onClose={() => setContextOpen(false)} />
    <Composer key={session} paneId="" connected agent="copilot" agentStatus={status} autoFocus={false}
      draftKey={hostDraftKey(machineId, session)} hostMenus={hostMenus} keywords={catalog?.agents.map((each) => each.name) ?? []}
      pills={pills} sendMenu={sendMenu}
      pending={chat?.pending ?? []} onRemovePending={(id) => { void removeHostPending(machineId, session, id).finally(reread); }}
      pendingNote={joined ? t("Added to your steer") : null}
      onSend={(text, _clear, _anyway, attached) => sendAs("send", text, attached)}
      attachAsChips onUploadImage={(file) => uploadHostFile(machineId, session, file)}
      onAbort={() => { void stopHost(machineId, session).finally(reread); }} />
    {sheet !== null && <ModelPicker machineId={machineId} focus={sheet} models={catalog?.models ?? null} agents={catalog?.agents ?? null} model={model} agent={agent} config={config} error={sheetError}
      onModel={pickModel} onAgent={pickAgent} onConfig={pickConfig} onClose={() => setSheet(null)} />}
  </div>;
}
