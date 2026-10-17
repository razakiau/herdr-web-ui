/**
 * "+ New VS Code chat": a sheet (a bottom sheet on a phone) that starts a chat in a folder of a PC
 * with its first message. The PC is the one whose button was tapped (another PC with VS Code chats
 * can be picked); its chats' folders are chips (lib/vscodeChats.ts folderChoices) and any absolute
 * path can be typed. Models and agents belong to a session, so the pills read them from the newest
 * chat in that folder, else the PC's newest (sessionForFolder); a PC with no chat yet offers only
 * "Agent", and the host uses its default model. "Start chat" posts once: a refusal keeps every field and
 * says why; a chat made opens, and if its first message did not go out, that message waits in its
 * composer (createVscodeChat): nothing is ever sent twice or a second chat made.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";

import "./NewSessionDialog.css";
import "./VscodeChatView.css";

import type { Machine } from "../../shared/machines.ts";
import type { VscodeAgent, VscodeModel } from "../../shared/vscode.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { createVscodeChat, fetchVscodeModels, folderChoices, sessionForFolder, type VscodePc } from "../lib/vscodeChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { VscodePickerSheet } from "./VscodePickerSheet.tsx";

export interface NewVscodeChatSheetProps {
  /** the PCs that offer VS Code chats, and each one's chats */
  machines: readonly Machine[];
  pcs: ReadonlyMap<string, VscodePc>;
  /** the PC whose "+ New VS Code chat" was tapped */
  machineId: string;
  onClose(): void;
  /** the chat made: the app opens it */
  onCreated(target: { machineId: string; session: string }): void;
}

const errorText = (cause: unknown): string => cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);

function basename(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

function agentName(uri: string): string {
  const file = decodeURIComponent(uri.split("/").pop() ?? uri);
  return file.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "") || uri;
}

export function NewVscodeChatSheet({ machines, pcs, machineId: initialMachine, onClose, onCreated }: NewVscodeChatSheetProps) {
  const t = useT();
  const id = useId();
  const [machineId, setMachineId] = useState(initialMachine);
  const chats = pcs.get(machineId)?.chats ?? [];
  const folders = folderChoices(chats);
  const [cwd, setCwd] = useState(() => folders[0] ?? "");
  const [text, setText] = useState("");
  const [model, setModel] = useState<{ id: string; effort?: string } | null>(null);
  // null: "Agent", VS Code's own (sent as no agent at all)
  const [agent, setAgent] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ models: VscodeModel[]; agents: VscodeAgent[] } | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"model" | "agent" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one post per tap: a second tap before the first's render is refused here
  const posting = useRef(false);

  // the PCs a chat can start on: connected, with a host up (and the one tapped, whatever its host says)
  const offered = machines.filter((machine) => machine.state === "connected" && pcs.has(machine.id) && (machine.id === initialMachine || pcs.get(machine.id)?.host?.state === "connected"));
  const source = sessionForFolder(chats, cwd);

  // the pills' models and agents are the source chat's: read again when the folder picks another chat
  useEffect(() => {
    setCatalogError(null);
    if (source === null) { setCatalog({ models: [], agents: [] }); return; }
    setCatalog(null);
    let live = true;
    void fetchVscodeModels(machineId, source).then((value) => {
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

  const close = (): void => { if (!posting.current) onClose(); };
  const surface = useFocusTrap<HTMLFormElement>(true);
  useSheetSwipe(surface, close);
  usePhoneSheetBack(() => posting.current ? false : onClose(), picker === null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // the picker over the sheet has its own Escape
      if (event.key !== "Escape" || picker !== null || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const pickMachine = (next: string): void => {
    setMachineId(next);
    setCwd(folderChoices(pcs.get(next)?.chats ?? [])[0] ?? "");
    setModel(null);
    setAgent(null);
    setError(null);
  };

  const start = async (): Promise<void> => {
    const folder = cwd.trim();
    const words = text.trim();
    if (folder === "" || words === "" || posting.current) return;
    posting.current = true;
    setPending(true);
    setError(null);
    try {
      const session = await createVscodeChat(machineId, {
        cwd: folder, text: words,
        ...(model ? { model } : {}),
        ...(agent !== null ? { agent } : {}),
      });
      posting.current = false;
      onCreated({ machineId, session });
    } catch (cause) {
      // nothing was made: every field stays for the user's next tap
      posting.current = false;
      setPending(false);
      setError(errorText(cause));
    }
  };

  const entry = catalog?.models.find((each) => each.id === model?.id);
  const modelLabel = model === null ? t("Model —") : entry?.name ?? model.id;
  const agentLabel = agent === null ? t("Agent") : catalog?.agents.find((each) => each.uri === agent)?.name ?? agentName(agent);
  // a PC with no chat yet has no session to read models from: the host's default model, and "Agent"
  const pickable = source !== null && !pending;
  const machineName = offered.find((machine) => machine.id === machineId)?.name ?? machines.find((machine) => machine.id === machineId)?.name ?? machineId;

  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <form ref={surface} className="modal new-session-modal new-vscode-chat" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{`${t("New VS Code chat")} · ${machineName}`}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={pending} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {offered.length > 1 && <label className="field">
            <span className="field-label">{t("PC")}</span>
            <select className="input" value={machineId} disabled={pending} onChange={(event) => pickMachine(event.target.value)}>
              {offered.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
            </select>
          </label>}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-cwd`}>{t("Folder")}</label>
            <input id={`${id}-cwd`} className="input" value={cwd} disabled={pending} autoComplete="off" autoCapitalize="off" spellCheck={false}
              placeholder="/" onChange={(event) => setCwd(event.target.value)} />
            <span className="field-hint">{t("An absolute path on that PC")}</span>
          </div>
          {folders.length > 0 && <div className="field new-session-recents">
            <span className="field-label" id={`${id}-folders`}>{t("Recent folders")}</span>
            <RecentFolderChips folders={folders} disabled={pending} labelledBy={`${id}-folders`} basename={basename} onPick={setCwd} />
          </div>}
          <div className="field">
            <span className="field-label" id={`${id}-pills`}>{t("Model and agent")}</span>
            <div className="new-vscode-chat-pills" role="group" aria-labelledby={`${id}-pills`}>
              <button type="button" className="composer-pill vscode-chat-pill vscode-chat-model" disabled={!pickable} aria-haspopup="dialog" aria-expanded={picker === "model"}
                aria-label={t("Model: {model}", { model: model?.effort ? `${modelLabel} · ${model.effort}` : modelLabel })} onClick={() => setPicker("model")}>
                <span className={`composer-model${model === null ? " is-none" : entry ? "" : " is-id"}`}>{modelLabel}</span>
                {model?.effort && <span className="composer-reasoning"><span className="composer-reasoning-dot" aria-hidden="true">·</span><span className="composer-reasoning-short">{model.effort}</span></span>}
                <ChevronDown className="vscode-chat-pill-caret" aria-hidden="true" />
              </button>
              <button type="button" className="composer-pill vscode-chat-pill vscode-chat-agent" disabled={!pickable} aria-haspopup="dialog" aria-expanded={picker === "agent"}
                aria-label={t("Agent: {agent}", { agent: agentLabel })} onClick={() => setPicker("agent")}>
                <span className="composer-model">{agentLabel}</span>
                <ChevronDown className="vscode-chat-pill-caret" aria-hidden="true" />
              </button>
            </div>
          </div>
          <label className="field">
            <span className="field-label">{t("First message")}</span>
            <textarea className="input new-vscode-chat-text" rows={4} value={text} disabled={pending} placeholder={t("Message VS Code")} spellCheck autoCapitalize="sentences" autoCorrect="on"
              onChange={(event) => setText(event.target.value)} />
          </label>
          {pending && <p className="new-session-note" role="status">{t("Starting…")}</p>}
          {error !== null && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={close}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending || cwd.trim() === "" || text.trim() === ""}>{t("Start chat")}</button>
        </footer>
      </form>
      {picker !== null && <VscodePickerSheet focus={picker} models={catalog?.models ?? null} agents={catalog?.agents ?? null}
        model={model ? { id: model.id, effort: model.effort ?? null } : null} agent={agent} error={catalogError}
        onModel={(next) => {
          setModel(next);
          // a model with an effort to pick keeps the picker open for it
          const picked = catalog?.models.find((each) => each.id === next.id);
          if (!picked?.efforts || next.effort !== undefined) setPicker(null);
        }}
        onAgent={(next) => { setAgent(next); setPicker(null); }}
        onClose={() => setPicker(null)} />}
    </div>,
    document.body,
  );
}
