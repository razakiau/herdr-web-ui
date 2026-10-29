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
import { chatCost } from "../lib/chatCost.ts";
import { fetchModelPrices, type ChatPrices } from "../lib/api.ts";
import { Eye, GitFork, RotateCw, SlidersHorizontal } from "lucide-react";

import "./ChatView.css";
import "./ChatTimeline.css";
import "./Composer.css";
import "./HostChatView.css";

import type { HostAgent, HostChatRead, HostModel, HostSessionConfig } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { hostSource } from "../lib/chatSource.ts";
import {
  agentName, answerHost, answerHostForm, choose, discardHostChat, forkHostChat, redoHostCheckpoint, restoreHostCheckpoint, chosenFor, confirmHost, errorText, fetchHostConfig, fetchHostFiles, fetchHostModels, hostDraftKey, removeHostPending, sendHostPendingNow,
  fetchChatCost, sendErrorText, sendHost, setHostConfig, uploadHostFile, setHostDraftModel, settleChoice, stopHost, stopHostBackground, type HostChoice,
} from "../lib/hostChats.ts";
import { settingsTone, type HostSendPick } from "../lib/compose.ts";
import { Composer, type AttachApi, type SentAttachment } from "./Composer.tsx";
import { AttachSheet, rememberAttached } from "./AttachSheet.tsx";
import "./AttachSheet.css";
import { HostChatStatus, HostContextMeter } from "./HostChatStatus.tsx";
import { SessionSheet } from "./SessionSheet.tsx";
import { HandoffBanner } from "./HandoffBanner.tsx";
import { useSettings } from "../lib/settings.ts";
import { handoffCommandText } from "../lib/compactContext.ts";
import { HostSessionPills } from "./HostSessionPills.tsx";
import { HostTodoBar } from "./HostTodoBar.tsx";
import { HostPendingRequests } from "./HostPendingRequests.tsx";
import type { SubagentTarget } from "./SubagentRow.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import { CheckpointBar, CheckpointSheet, filesSince } from "./HostCheckpoint.tsx";
import { ChatView } from "./ChatView.tsx";
import { PromptCardView, type PromptChoice } from "./PromptCard.tsx";
import { APPROVALS_LABEL, MODE_LABEL, ModelMarkIcon, ModelPicker } from "./ModelPicker.tsx";
import { providerMark, rowDetail, shortModelName } from "../lib/modelProvider.ts";
import { hostSlashItems, resolveHostSlash } from "../lib/hostSlash.ts";
import { STALL_MS, stalledMessage } from "../lib/hostStall.ts";

export interface HostChatViewProps {
  machineId: string; session: string;
  /** the chat's title as its reads give it: the header's, before the PC's list has the chat */
  onTitle?(title: string): void;
  /** opens another chat of this PC: a fork just made */
  onOpenChat?(session: string): void;
  /** set while the chat is a look (opened from Agents, All agents or an alert, not a tab): keeps it open as a tab */
  look?(): void;
  /** opens a file of this PC in herdr's viewer: an edit's file, a session's file artifact */
  onOpenFile?(path: string): void;
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
    attachSheet={{ machineId, session }}
    onUploadFile={(file) => uploadHostFile(machineId, session, file)} />;
}

/** a price request that answered with neither table */
const NO_PRICES: ChatPrices = { prices: null, fallback: null };

export function HostChatView({ machineId, session, onTitle, onOpenChat, look, onOpenFile }: HostChatViewProps) {
  const lookRef = useRef(look); lookRef.current = look;
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
  const [sheet, setSheet] = useState<"model" | "settings" | null>(null);
  // the attach sheet is open with the composer's handle (Composer's attachMenu)
  const [attaching, setAttaching] = useState<AttachApi | null>(null);
  const [config, setConfig] = useState<HostSessionConfig | null>(null);
  const [catalog, setCatalog] = useState<{ models: HostModel[]; agents: HostAgent[] } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  // OmniRoute's prices, once the context sheet is first opened: the cost is only shown there
  // asked on every open until both tables are in (fetchModelPrices keeps them for the page then)
  const [prices, setPrices] = useState<ChatPrices | null>(null);
  // the price request answered, if with nothing: the Session sheet then prices nothing (a floor,
  // every model named) instead of waiting; `prices` itself stays unset, as the estimate reads it
  const [pricesAnswered, setPricesAnswered] = useState(false);
  useEffect(() => {
    if (!contextOpen) return;
    void fetchModelPrices().then((value) => {
      if (!mounted.current) return;
      setPricesAnswered(true);
      if (value.prices || value.fallback) setPrices(value);
    });
  }, [contextOpen]);
  // the bridge's log of the chat (ZAC-260) while costs are tracked, for the meter's cache timer,
  // the handoff banner and the Session sheet: asked when the chat opens, when a turn ends and on
  // each open of the sheet; never on a timer (the minute clock moves the cache's state).
  // undefined while asked, null from a bridge before costs
  const { settings: { trackCosts, costHandoffAt, cacheLifetimeMin } } = useSettings();
  const [chatCostLog, setChatCostLog] = useState<Awaited<ReturnType<typeof fetchChatCost>> | undefined>(undefined);
  const turnRunning = chat?.busy ?? false;
  const costAsked = useRef(false);
  useEffect(() => {
    if (!trackCosts) { costAsked.current = false; return; }
    // a turn starting changes nothing the log says yet: asked again when it ends
    if (costAsked.current && turnRunning && !contextOpen) return;
    costAsked.current = true;
    let live = true;
    void fetchChatCost(machineId, session).then((value) => { if (live) setChatCostLog(value); }, () => { /* kept: the last answer, or still asking */ });
    return () => { live = false; };
  }, [contextOpen, trackCosts, machineId, session, turnRunning]);
  const cost = useMemo(() => {
    const tokens = chat?.tokens;
    if (!prices || !tokens || tokens.totals.length === 0) return null;
    return { ...chatCost(tokens.totals, prices.prices ?? {}, prices.fallback), partial: tokens.partial };
  }, [chat?.tokens, prices]);
  // the checkpoint a tap asked to restore (its sheet is up), and the message a restore put back in the box
  const [restoring, setRestoring] = useState<string | null>(null);
  // Fork Conversation: the request being forked at, and why the last one failed
  const [forking, setForking] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  // a message the agent never started on (lib/hostStall.ts): looked at again when it could turn
  // stalled, and offered again as Stop and Send, what the owner did by hand
  const [stallTick, setStallTick] = useState(0);
  const [resending, setResending] = useState<string | null>(null);
  const stalled = chat ? stalledMessage(chat, Date.now()) : null;
  const askedAt = chat?.busy ? Date.parse(chat.turns.at(-2)?.ts ?? "") : NaN;
  useEffect(() => {
    if (!Number.isFinite(askedAt)) return;
    const wait = askedAt + STALL_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setStallTick((tick) => tick + 1), wait + 50);
    return () => clearTimeout(timer);
  }, [askedAt, stallTick]);
  const [putBack, setPutBack] = useState<string | null>(null);
  const mounted = useRef(true);
  // the transcript's handle: the "N running" sheet takes the reader to a subagent's row
  const revealSubagent = useRef<((target: SubagentTarget) => boolean) | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // VS Code's New Chat opened empty: left with no message, it goes (the bridge refuses any other chat)
  const unused = useRef(true);
  useEffect(() => () => {
    const last = source.last();
    if (unused.current && last !== null && last.turns.length === 0 && !last.busy && (last.pending ?? []).length === 0) void discardHostChat(machineId, session).catch(() => undefined);
  }, [machineId, session, source]);
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
  // change made in VS Code shows here. Every read, not every changed one: a permission switched in
  // VS Code leaves the transcript's signature alone, and keyed on the chat object it never showed
  const readConfig = useCallback(() => {
    void fetchHostConfig(machineId, session).then((value) => { if (mounted.current) setConfig((current) => JSON.stringify(current) === JSON.stringify(value) ? current : value); }, () => undefined);
  }, [machineId, session]);
  useEffect(() => { if (source.last() !== null) readConfig(); }, [readConfig, source]);
  useEffect(() => source.onRead(readConfig), [readConfig, source]);
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

  const openSheet = (part: "model" | "settings"): void => {
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
    // a folder file sent with the chat is one tap away in the attach sheet next time
    rememberAttached(machineId, session, attached.flatMap((each) => each.media_type === undefined ? [each.path] : []));
    const slash = resolveHostSlash(text.trim());
    const words = slash ? slash.text : text.trim();
    try {
      if (slash) {
        await setHostConfig(machineId, session, { ...(slash.config["mode"] ? { mode: slash.config["mode"] } : {}), ...(slash.config["autoApprove"] ? { approvals: slash.config["autoApprove"] } : {}) });
        if (mounted.current) void fetchHostConfig(machineId, session).then((value) => { if (mounted.current) setConfig(value); }, () => undefined);
        if (words === "" && attached.length === 0) return true;
      }
      unused.current = false;
      // a message sent in a look keeps it open: the user acts in it
      lookRef.current?.();
      // sent: sendHost lets the stored draft go even if this screen is gone by now
      const result = await sendHost(machineId, { session, text: words, ...(mode === "send" ? {} : { mode }), ...(attached.length > 0 ? { attachments: attached } : {}) }, { model: chat?.model ?? null, agent: chat?.agent ?? null }, true);
      if (mounted.current) {
        setJoined(result.joined === true);
        // a restore's message went (or another did): the box is the user's again
        setPutBack(null);
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

  // VS Code's Fork Conversation: a new chat with the turns before the request, opened once the PC has it
  const openChat = useRef(onOpenChat); openChat.current = onOpenChat;
  const fork = useCallback((turn: string) => {
    if (forking !== null) return;
    setForking(turn);
    setForkError(null);
    void forkHostChat(machineId, session, turn).then(({ session: forked }) => {
      if (mounted.current) setForking(null);
      openChat.current?.(forked);
    }, (cause: unknown) => {
      if (mounted.current) { setForking(null); setForkError(errorText(cause)); }
    });
  }, [forking, machineId, session]);
  // VS Code's checkpoints: a tap opens the sheet; a restore puts the files back, fades the turns
  // from that message on and puts its text in the box; the next send cuts the chat there
  const checkpointList = chat?.checkpoints ?? null;
  const restoredTurn = chat?.restored?.turn ?? null;
  const [showChanges, setShowChanges] = useState<{ paths: string[]; at: number } | null>(null);
  const [changedPaths, setChangedPaths] = useState<ReadonlySet<string> | null>(null);
  // VS Code's pending requests, at the transcript's end (ChatView is memoized: the element is kept
  // while the waiting messages are the same, so a parent render does not redraw the chat)
  const pendingKey = JSON.stringify(chat?.pending ?? []);
  const pendingTail = useMemo(() => <HostPendingRequests pending={JSON.parse(pendingKey) as HostChatRead["pending"]}
    onSendNow={async (id) => { try { await sendHostPendingNow(machineId, session, id); setSent((key) => key + 1); return null; } catch (cause) { return sendErrorText(cause, t); } finally { reread(); } }}
    onEdit={(row) => { void removeHostPending(machineId, session, row.id).then(() => { if (mounted.current) setPutBack(row.text); }, () => undefined).finally(reread); }}
    onRemove={(id) => { void removeHostPending(machineId, session, id).finally(reread); }} />,
  [machineId, pendingKey, session, t]);
  const checkpoints = useMemo(() => checkpointList === null ? null
    : { list: checkpointList, restored: restoredTurn, onPick: (turn: string) => setRestoring(turn), ...(onOpenChat ? { onFork: fork } : {}),
      changedPaths, onViewChanges: (paths: string[]) => setShowChanges({ paths, at: Date.now() }) }, [checkpointList, restoredTurn, onOpenChat, fork, changedPaths]);
  const restoringAt = restoring === null || checkpointList === null ? -1 : checkpointList.findIndex((each) => each.turn === restoring);
  const restoreText = (turn: string): string | null => {
    const at = checkpointList?.findIndex((each) => each.turn === turn) ?? -1;
    if (chat === null || at < 0) return null;
    const users = chat.turns.filter((each) => each.role === "user");
    const user = users[users.length - (checkpointList!.length - at)];
    return user?.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n\n") ?? null;
  };
  const costSettings = { trackCosts, costHandoffAt, cacheLifetimeMin };
  // VS Code's /handoff, from the Session sheet and the banner: only while idle, and only when the session lists the command
  const onHandoff = chat && !chat.busy && handoffCommandText(chat.commands) ? () => { void sendAs("send", "/handoff"); } : undefined;
  const label = t("Copilot chat {title}", { title: chat?.title ?? "" });
  const modeLabel = config?.mode ? t(MODE_LABEL[config.mode] ?? config.mode) : null;
  const approvalsLabel = config?.approvals ? t(APPROVALS_LABEL[config.approvals] ?? config.approvals) : null;
  const detail = modelEntry ? rowDetail(modelEntry, model?.effort ?? null) : model?.effort ?? "";
  // VS Code's input toolbar: quiet triggers that say what the next message goes with, each opening its picker
  // the host's default level until one is picked: the message is sent with it either way
  const shownEffort = model?.effort ?? (model && modelEntry?.id === model.id ? modelEntry.efforts?.default ?? null : null);
  const effortLabel = shownEffort ? shownEffort.charAt(0).toUpperCase() + shownEffort.slice(1) : null;
  // one settings button (ZAC-207 redesign): mode, permissions and agent in one sheet; it wears the
  // notice colour for a raised permission level, as the mode pill's shield did
  const settings = <button type="button" className="icon-button host-chat-settings" aria-haspopup="dialog" aria-expanded={sheet === "settings"}
    data-tone={settingsTone(config?.approvals)}
    aria-label={t("Chat settings: {0}, {1}, {2}", { 0: modeLabel ?? "—", 1: approvalsLabel ?? "—", 2: agentLabel })}
    title={[modeLabel, approvalsLabel, agentLabel].filter(Boolean).join(" · ")} onClick={() => openSheet("settings")}>
    <SlidersHorizontal aria-hidden="true" />
  </button>;
  const pills = <span className="host-chat-pills">
    <button type="button" className="host-chat-pill host-chat-model" aria-haspopup="dialog" aria-expanded={sheet === "model"}
      aria-label={t("Model: {model}", { model: detail ? `${modelLabel} · ${detail}` : modelLabel })} title={detail ? `${modelLabel} · ${detail}` : modelLabel} onClick={() => openSheet("model")}>
      {modelEntry && <ModelMarkIcon mark={providerMark(modelEntry)} size={14} />}
      <span className={`host-chat-pill-label${model === null ? " is-none" : modelEntry ? "" : " is-id"}`}>{modelEntry ? shortModelName(modelEntry) : modelLabel}</span>
      {effortLabel && <span className="host-chat-pill-aside">{effortLabel}</span>}
    </button>
    {/* a mouse window names a custom agent by the model, as VS Code's toolbar does; a phone has it in the sheet */}
    {agent !== null && <span className="host-chat-agent-name">{agentLabel}</span>}
  </span>;

  return <div className="terminal-stack is-chat host-chat" data-host-session={session}>
    <div className="terminal-surface">
      {/* the app's chat, read from the host: no pane, no terminal, no scrollback (ChatView's source) */}
      <OpenFileContext.Provider value={onOpenFile ?? null}>
        <ChatView paneId="" source={source} label={label} refreshKey={refresh} sentKey={sent} revealSubagent={revealSubagent}
          connected ended={false} agent="copilot" agentStatus={status} checkpoints={checkpoints}
          tail={pendingTail} />
      </OpenFileContext.Provider>
    </div>
    <div className="prompt-dock" aria-live="polite">
      {chat?.prompt && <HostPromptCard key={chat.prompt.id} machineId={machineId} session={session} prompt={chat.prompt} onPromptChanged={reread} onAnswered={() => {
        setChat((current) => current === null ? current : { ...current, prompt: null });
        reread();
      }} />}
    </div>
    {look && <div className="checkpoint-bar look-bar">
      <Eye className="checkpoint-bar-icon" aria-hidden="true" />
      <span className="checkpoint-bar-text">{t("Not open in its workspace")}</span>
      <button type="button" className="btn btn-ghost checkpoint-bar-redo" onClick={look}>{t("Keep open")}</button>
    </div>}
    {stalled && <div className="checkpoint-bar stall-bar" role="status">
      <RotateCw className="checkpoint-bar-icon" aria-hidden="true" />
      <span className="checkpoint-bar-text">{t("No reply yet: the agent may not have received it")}</span>
      {resending !== null && resending !== "" && <span className="checkpoint-bar-error" role="alert">{resending}</span>}
      <button type="button" className="btn btn-ghost checkpoint-bar-redo" disabled={resending === ""} onClick={() => {
        setResending("");
        void sendAs("stop_and_send", stalled.text).then((answer) => { if (mounted.current) setResending(answer === true ? null : answer || null); });
      }}>{t("Stop and resend")}</button>
    </div>}
    {(forking !== null || forkError !== null) && <div className="checkpoint-bar fork-bar" role="status">
      <GitFork className="checkpoint-bar-icon" aria-hidden="true" />
      <span className="checkpoint-bar-text">{forking !== null ? t("Forking conversation…") : t("Couldn't fork the conversation")}</span>
      {forkError !== null && <span className="checkpoint-bar-error" role="alert">{forkError}</span>}
      {forkError !== null && <button type="button" className="btn btn-ghost checkpoint-bar-redo" onClick={() => setForkError(null)}>{t("Dismiss")}</button>}
    </div>}
    {chat?.restored && <CheckpointBar files={chat.restored.files} onRedo={async () => {
      await redoHostCheckpoint(machineId, session);
      if (mounted.current) { setPutBack(null); reread(); }
    }} />}
    <HostChatStatus read={chat} workShown={(chat?.work ?? []).length > 0} />
    <HandoffBanner dismissKey={`${machineId}\n${session}`} read={chat} log={chatCostLog?.chat} settings={costSettings} onHandoff={onHandoff} />
    {/* the session's pills sit under the box (`foot`; owner, ZAC-228: above it they sandwiched the
        todo tab), and stay while a question or approval is up: what the session made is often what it is about */}
    <Composer key={session} paneId="" connected agent="copilot" agentStatus={status} autoFocus={false}
      toolbarEnd={<HostContextMeter read={chat} open={contextOpen} onOpen={() => setContextOpen(true)} onClose={() => setContextOpen(false)} cost={cost}
        costs={{ log: chatCostLog?.chat ?? (chatCostLog === undefined ? undefined : null), settings: costSettings }}
        onCompact={chat && !chat.busy ? () => { void sendAs("send", "/compact"); } : undefined}
        sheet={trackCosts && chat ? <SessionSheet read={chat} estimate={cost} cost={chatCostLog} prices={prices ?? (pricesAnswered ? NO_PRICES : null)}
          settings={costSettings} onClose={() => setContextOpen(false)}
          onCompact={!chat.busy ? () => { void sendAs("send", "/compact"); } : undefined}
          onHandoff={onHandoff} /> : undefined} />}
      draftKey={hostDraftKey(machineId, session)} hostMenus={hostMenus} restored={putBack} keywords={catalog?.agents.map((each) => each.name) ?? []}
      pills={pills} settingsButton={settings} sendMenu={sendMenu}
      tray={<HostTodoBar todos={chat?.todos} busy={chat?.busy ?? false} />}
      foot={<HostSessionPills machineId={machineId} session={session} showChanges={showChanges} onChangedPaths={setChangedPaths} changesKey={chat ? `${chat.busy}:${chat.message_ids.length}` : undefined} artifacts={chat?.artifacts ?? []} work={chat?.work ?? []} onOpenFile={(path) => onOpenFile?.(path)}
      onStop={async (id) => { try { await stopHostBackground(machineId, session, id); } finally { reread(); } }}
      onRevealSubagent={(target) => revealSubagent.current?.(target) ?? false} />}
      pendingNote={joined ? t("Added to your steer") : null}
      onSend={(text, _clear, _anyway, attached) => sendAs("send", text, attached)}
      attachMenu={setAttaching}
      attachAsChips onUploadImage={(file) => uploadHostFile(machineId, session, file)}
      onAbort={() => { void stopHost(machineId, session).finally(reread); }} />
    {restoring !== null && restoringAt >= 0 && <CheckpointSheet first={restoringAt === 0 && chat?.cursor === null} files={filesSince(checkpointList!, restoring)}
      later={checkpointList!.length - restoringAt} busy={busy} onStop={() => { void stopHost(machineId, session).finally(reread); }} onClose={() => setRestoring(null)} onRestore={async () => {
        const text = restoreText(restoring);
        await restoreHostCheckpoint(machineId, session, restoring);
        if (!mounted.current) return;
        setRestoring(null);
        if (text !== null) setPutBack(text);
        reread();
      }} />}
    {attaching !== null && <AttachSheet machineId={machineId} session={session} api={attaching} onClose={() => setAttaching(null)} />}
    {sheet !== null && <ModelPicker machineId={machineId} focus={sheet} models={catalog?.models ?? null} agents={catalog?.agents ?? null} model={model} agent={agent} config={config} error={sheetError}
      onModel={pickModel} onAgent={pickAgent} onConfig={pickConfig} onClose={() => setSheet(null)} />}
  </div>;
}
