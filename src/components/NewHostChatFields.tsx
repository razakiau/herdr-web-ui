/**
 * The "+" dialog's Copilot host choice (NewSessionDialog, kind `copilot-host`): in place of the
 * name field, a first message, and the chat's model, agent and mode as the chat's own triggers
 * show them. Models and agents belong to a session, so they are read from the newest chat in the
 * folder, else the PC's newest (sessionForFolder); a PC with none offers "Agent" and the host's
 * default model. Start posts once (createHostChat, under one id while the same words are tried
 * again); the mode is set on the chat once it is made.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChevronDown, ListChecks, MessageSquare, Rocket } from "lucide-react";

import "./HostChatView.css";

import type { HostAgent, HostChatRow, HostModel } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { agentName, attemptFor, createHostChat, errorText, fetchHostModels, sendErrorText, sessionForFolder, setHostConfig } from "../lib/hostChats.ts";
import { providerMark, shortModelName } from "../lib/modelProvider.ts";
import { MODE_LABEL, ModelMarkIcon, ModelPicker } from "./ModelPicker.tsx";

/** VS Code's modes for a Copilot chat; the session's own list exists only once the chat does. */
const NEW_CHAT_MODES = ["interactive", "plan", "autopilot"] as const;

export interface NewHostChatHandle {
  /** starts the chat in `cwd`: its session, or a reason it was not made (every field stays) */
  start(cwd: string): Promise<{ session: string } | { error: string }>;
  ready(): boolean;
}

export const NewHostChatFields = forwardRef<NewHostChatHandle, { machineId: string; chats: readonly HostChatRow[]; cwd: string; disabled: boolean; onChange(): void }>(
  function NewHostChatFields({ machineId, chats, cwd, disabled, onChange }, ref) {
    const t = useT();
    const [text, setText] = useState("");
    const [model, setModel] = useState<{ id: string; effort?: string } | null>(null);
    // null: "Agent", VS Code's own (sent as no agent at all)
    const [agent, setAgent] = useState<string | null>(null);
    const [mode, setMode] = useState<string>("interactive");
    const [catalog, setCatalog] = useState<{ models: HostModel[]; agents: HostAgent[] } | null>(null);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [picker, setPicker] = useState<"model" | "agent" | "mode" | null>(null);
    // the id this chat goes under: kept while the same folder and words are tried again after a
    // failure (the bridge then makes the chat once), new when either changes
    const attempt = useRef<{ key: string; id: string } | null>(null);
    const source = sessionForFolder([...chats], cwd);

    useEffect(() => {
      setCatalogError(null);
      if (source === null) { setCatalog({ models: [], agents: [] }); return; }
      setCatalog(null);
      let live = true;
      void fetchHostModels(machineId, source).then((value) => {
        if (!live) return;
        setCatalog(value);
        // a pick the new list does not offer is dropped, not sent
        setModel((current) => current && value.models.some((each) => each.id === current.id) ? current : null);
        setAgent((current) => current !== null && !value.agents.some((each) => each.uri === current) ? null : current);
      }, (cause: unknown) => {
        if (!live) return;
        setCatalogError(errorText(cause));
        setCatalog({ models: [], agents: [] });
      });
      return () => { live = false; };
    }, [machineId, source]);

    useImperativeHandle(ref, () => ({
      ready: () => text.trim() !== "",
      async start(folder) {
        const words = text.trim();
        attempt.current = attemptFor(attempt.current, JSON.stringify([machineId, folder, words]));
        try {
          const session = await createHostChat(machineId, {
            id: attempt.current.id, cwd: folder, text: words,
            ...(model ? { model } : {}),
            ...(agent !== null ? { agent } : {}),
          });
          // the chat is made: its mode follows (a failure leaves it Interactive, which the chat's own trigger shows)
          if (mode !== "interactive") await setHostConfig(machineId, session, { mode }).catch(() => undefined);
          return { session };
        } catch (cause) {
          return { error: sendErrorText(cause, t, true) };
        }
      },
    }), [agent, machineId, mode, model, t, text]);

    const entry = catalog?.models.find((each) => each.id === model?.id);
    const modelLabel = model === null ? t("Model —") : entry?.name ?? model.id;
    const agentLabel = agent === null ? t("Agent") : catalog?.agents.find((each) => each.uri === agent)?.name ?? agentName(agent);
    const effortLabel = model?.effort ? model.effort.charAt(0).toUpperCase() + model.effort.slice(1) : null;
    const ModeIcon = mode === "plan" ? ListChecks : mode === "autopilot" ? Rocket : MessageSquare;
    const modeLabel = t(MODE_LABEL[mode] ?? mode);
    // a PC with no chat yet has no session to read models from: the host's default model, and "Agent"
    const pickable = source !== null && !disabled;

    return <>
      <label className="field">
        <span className="field-label">{t("First message")}</span>
        <textarea className="input new-host-chat-text" rows={4} value={text} disabled={disabled} placeholder={t("Message Copilot")} spellCheck autoCapitalize="sentences" autoCorrect="on"
          onChange={(event) => { setText(event.target.value); onChange(); }} />
      </label>
      <div className="new-host-chat-pills host-chat-pills" role="group" aria-label={t("Model and agent")}>
        <button type="button" className="host-chat-pill host-chat-model" disabled={!pickable} aria-haspopup="dialog" aria-expanded={picker === "model"}
          aria-label={t("Model: {model}", { model: model?.effort ? `${modelLabel} · ${model.effort}` : modelLabel })} title={modelLabel} onClick={() => setPicker("model")}>
          {entry && <ModelMarkIcon mark={providerMark(entry)} size={14} />}
          <span className={`host-chat-pill-label${model === null ? " is-none" : entry ? "" : " is-id"}`}>{entry ? shortModelName(entry) : modelLabel}</span>
          {effortLabel && <span className="host-chat-pill-aside">{effortLabel}</span>}
          <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
        </button>
        <button type="button" className="host-chat-pill host-chat-agent" disabled={!pickable} aria-haspopup="dialog" aria-expanded={picker === "agent"}
          aria-label={t("Agent: {agent}", { agent: agentLabel })} onClick={() => setPicker("agent")}>
          <span className="host-chat-pill-label">{agentLabel}</span>
          <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
        </button>
        <button type="button" className="host-chat-pill host-chat-mode" disabled={disabled} aria-haspopup="dialog" aria-expanded={picker === "mode"}
          title={modeLabel} aria-label={t("Agent mode: {mode}", { mode: modeLabel })} onClick={() => setPicker("mode")}>
          <ModeIcon className="host-chat-pill-icon" aria-hidden="true" />
          <span className="host-chat-pill-label">{modeLabel}</span>
          <ChevronDown className="host-chat-pill-caret" aria-hidden="true" />
        </button>
      </div>
      {picker !== null && <ModelPicker machineId={machineId} focus={picker} models={catalog?.models ?? null} agents={catalog?.agents ?? null}
        model={model ? { id: model.id, effort: model.effort ?? null } : null} agent={agent} error={catalogError}
        config={{ mode, approvals: null, modes: [...NEW_CHAT_MODES], approvalModes: [] }}
        onModel={(next) => { setModel(next); setPicker(null); }}
        onAgent={(next) => { setAgent(next); setPicker(null); }}
        onConfig={(change) => { if (change.mode) setMode(change.mode); setPicker(null); }}
        onClose={() => setPicker(null)} />}
    </>;
  },
);
