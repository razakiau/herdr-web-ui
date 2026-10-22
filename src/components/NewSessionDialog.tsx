import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Folder, FolderOpen, Search, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError } from "../lib/api.ts";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { launchAgent } from "../lib/agentLaunchMode.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { passingFolder, recentDirectories } from "../lib/recent-directories.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { chatAge, folderChoices, offeredAgents, useMinuteClock } from "../lib/hostChats.ts";
import { hostFolders, type PcHostWorkspaces } from "../lib/hostWorkspaces.ts";
import "./AllAgentsSheet.css";
import { HOST_AGENT_KIND } from "../../shared/supported-agents.ts";
import { NewHostChatFields, type NewHostChatHandle } from "./NewHostChatFields.tsx";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /** `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens */
  onCreated: (paneId: string, agentStarted: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
  /** the PC's open linked worktree checkouts: no project to offer among the recent folders */
  worktrees?: readonly string[];
  /** the PC's host chats (agent host): their folders join the recent ones, and their models the new chat's */
  hostChats?: readonly HostChatRow[];
  /** an agent host chat was made: the app opens it */
  onHostChat?: (session: string, cwd: string) => void;
  /** the PC's open agent host workspaces: the folder list marks them */
  hostOpen?: PcHostWorkspaces;
  /** a folder picked from the agent host list: the app opens its workspace, and makes no chat */
  onOpenHostWorkspace?: (cwd: string) => void;
  /** New agent host chat… from a folder's ⋯: a new chat in that folder, not a workspace to open */
  chatIn?: string | null;
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;
/** recent folders offered: one row a phone swipes sideways; a wider screen fits what one row holds and lists the rest under "+N" */
const RECENT_FOLDERS_SHOWN = 8;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || value;
}

export function NewSessionDialog({ open, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft, worktrees = [], hostChats = [], onHostChat, hostOpen, onOpenHostWorkspace, chatIn = null }: NewSessionDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const machineId = useMachineId();
  const { createTab, createWorkspace, fetchAgentKinds } = useMachineApi();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [recentFolders, setRecentFolders] = useState(() => recentDirectories.read(machineId));
  // a folder picked from the agent host list: Start opens its workspace, and makes no chat
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const [folderQuery, setFolderQuery] = useState("");
  // folders kept before worktrees and temporary folders were left out are left out here too
  const hostChoice = agentKind === HOST_AGENT_KIND;
  const now = useMinuteClock();
  const hostFields = useRef<NewHostChatHandle>(null);
  // an agent host chat also offers the folders its PC's chats work in, after the recent ones
  // (where a chat already works is a folder of its own, wherever it is: the passing-folder rule is the recents')
  const shownFolders = [...new Set([...(hostChoice ? folderChoices([...hostChats]) : []), ...recentFolders.filter((path) => !passingFolder(path, worktrees))])].slice(0, RECENT_FOLDERS_SHOWN);
  // New workspace → Agent host: the folders its chats work in, to open one as a workspace
  const hostFolderList = hostChoice && !tab && chatIn === null && onOpenHostWorkspace ? hostFolders(hostChats, hostOpen) : [];
  const folderWords = folderQuery.trim().toLowerCase();
  const listedFolders = folderWords === "" ? hostFolderList : hostFolderList.filter((folder) => folder.cwd.toLowerCase().includes(folderWords));
  const opensWorkspace = hostFolderList.length > 0 && pickedFolder !== null && pickedFolder === cwd;
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  // a path longer than its field is shown from its end, where the folder's name is, whenever it is
  // set for the user (the last folder, a pick from Browse or a recent chip) and when the field is
  // left; typing keeps the caret in view by itself
  const cwdField = useRef<HTMLInputElement>(null);
  const showPathEnd = (): void => {
    const field = cwdField.current;
    if (field !== null) field.scrollLeft = field.scrollWidth;
  };
  useLayoutEffect(() => {
    if (open && document.activeElement !== cwdField.current) showPathEnd();
  }, [open, cwd]);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef });
  useSheetSwipe(surface, pending ? null : onClose);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  // The previous launch may have left disabled fields: reset them before the opening paint.
  useLayoutEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    setCwd(filled?.cwd ?? defaultCwdRef.current ?? "");
    setName(filled?.name ?? "");
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setBrowsing(false);
    setPickedFolder(null);
    setFolderQuery("");
    setRecentFolders(recentDirectories.read(machineId));
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((all) => {
        if (cancelled) return;
        // Agent host only while Settings shows agent host chats
        const next = offeredAgents(all, settings.hostChatsShown);
        setAgents(next);
        // a linked agent herdr does not offer gives way to the last one picked, as an unknown remembered one does to a shell
        if (stored && !next.some((agent) => agent.kind === stored)) setAgentKind(stored !== remembered && next.some((agent) => agent.kind === remembered) ? remembered : "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(userErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = hostChoice ? t("Starting…") : selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || createdPaneId !== null;

  const startHostChat = async (directory: string): Promise<void> => {
    const folder = directory.trim();
    if (pending || folder === "" || !hostFields.current?.ready()) return;
    setPending(true);
    setError(null);
    rememberAgent(agentKind);
    const made = await hostFields.current.start(folder);
    setPending(false);
    if ("error" in made) { setError({ message: made.error, detail: null }); return; }
    setRecentFolders(recentDirectories.remember(machineId, [folder], true));
    onHostChat?.(made.session, folder);
  };

  const startWorkspace = async (directory: string): Promise<void> => {
    if (pending) return;
    if (hostChoice) { await startHostChat(tab?.cwd ?? directory); return; }
    if (createdPaneId !== null) { onCreated(createdPaneId, false); return; }
    setPending(true);
    setError(null);
    try {
      rememberAgent(agentKind);
      const agent = launchAgent(agentKind, settings);
      // a tab keeps the workspace's folder, which the dialog shows and does not ask for
      const result = tab
        ? await createTab({ workspace_id: tab.workspaceId, cwd: tab.cwd, label: name.trim() || null, agent })
        : await createWorkspace({ cwd: directory.trim() || null, label: name.trim() || null, agent });
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        // the workspace exists: say so plainly, keep the PC's own words beneath, and Open it rather than make another
        setError({ message: t("The workspace opened, but {agent} did not start. Check that it is installed on the PC, then open it again.", { agent: selectedAgent?.label ?? agentKind }), detail: result.error.message });
        setCreatedPaneId(result.pane_id);
        return;
      }
      if (!tab && (!agentKind || result.agent_started)) {
        setRecentFolders(recentDirectories.remember(machineId, [directory.trim()], true));
      }
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      setPending(false);
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError({ message: t("Directory not found"), detail: null });
      else setError(userErrorMessage(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void startWorkspace(cwd); }}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{tab ? `${t("New tab")} · ${tab.workspaceLabel}` : chatIn !== null ? `${t("New chat")} · ${directoryBasename(chatIn)}` : `${t("New workspace")} · ${machineName ?? machineId}`}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" onChange={setAgentKind} />
          </div>
          {tab ? (
            <div className="field">
              <span className="field-label">{t("Directory")}</span>
              <div className="new-session-folder">
                <FolderOpen aria-hidden="true" />
                <span>{tab.cwd ?? tab.workspaceLabel}</span>
              </div>
              <span className="field-hint">{t("Uses the workspace's folder")}</span>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
              <div className="new-session-cwd">
                <input ref={cwdField} id="new-session-cwd" className="input" value={cwd} placeholder="~/projects/app" disabled={fieldsDisabled} autoComplete="off" onChange={(event) => { setCwd(event.target.value); setPickedFolder(null); }} onBlur={showPathEnd} />
                <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                  <FolderOpen aria-hidden="true" />
                  {t("Browse")}
                </button>
              </div>
              {/* Browse updates Directory as you open folders, so Start uses what the path bar shows
                  even when Use this folder was never pressed (issue #1162); a folder under home
                  keeps the `~/…` form typed or picked, rather than turning absolute on opening Browse. */}
              {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setPickedFolder(null); setBrowsing(false); }} onFolder={(path, home) => { setCwd(homeRelative(path, home)); setPickedFolder(null); }} />}
              <span className="field-hint">{t("absolute path or ~/…")}</span>
            </div>
          )}
          {hostFolderList.length > 0 && <div className="field new-host-folders">
            <span className="field-label" id="new-host-folders">{t("Folders with chats")}</span>
            {hostFolderList.length > 5 && <label className="all-agents-search new-host-folders-search">
              <Search aria-hidden="true" />
              <input className="input" type="search" value={folderQuery} aria-label={t("Search folders")} placeholder={t("Search folders")}
                autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={fieldsDisabled} onChange={(event) => setFolderQuery(event.target.value)} />
            </label>}
            <ul className="new-host-folder-list" role="radiogroup" aria-labelledby="new-host-folders">
              {listedFolders.map((folder) => {
                const on = opensWorkspace && pickedFolder === folder.cwd;
                return <li key={folder.cwd}>
                  <button type="button" role="radio" aria-checked={on} className={`new-host-folder${on ? " is-on" : ""}`} disabled={fieldsDisabled} title={folder.cwd}
                    onClick={() => { setCwd(folder.cwd); setPickedFolder(folder.cwd); setBrowsing(false); }}>
                    <Folder className="new-host-folder-icon" aria-hidden="true" />
                    <span className="new-host-folder-copy">
                      <span className="new-host-folder-name">{directoryBasename(folder.cwd)}{folder.open && <span className="pill new-host-folder-open">{t("Open")}</span>}</span>
                      <span className="new-host-folder-path"><bdi dir="ltr">{folder.cwd}</bdi></span>
                    </span>
                    <span className="new-host-folder-meta">{folder.chats === 1 ? t("1 chat") : t("{n} chats", { n: folder.chats })} · {chatAge({ modified_at: folder.modified_at } as HostChatRow, now, t)}</span>
                  </button>
                </li>;
              })}
              {listedFolders.length === 0 && <li className="field-hint">{t("No folder matches")}</li>}
            </ul>
            <span className="field-hint">{t("Pick one to open it as a workspace or start a new chat there.")}</span>
          </div>}
          {!tab && chatIn === null && shownFolders.length > 0 && hostFolderList.length === 0 && <div className="field new-session-recents">
            <span className="field-label" id="new-session-recents">{t("Recent folders")}</span>
            <RecentFolderChips folders={shownFolders} disabled={fieldsDisabled} labelledBy="new-session-recents" basename={directoryBasename}
              onPick={(path) => { setCwd(path); setBrowsing(false); }} />
          </div>}
          {hostChoice ? <NewHostChatFields ref={hostFields} machineId={machineId} /> : <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_LABEL_CHARS}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={tab ? String(tab.number) : directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">{t(tab ? "Tab name (optional)" : "Optional workspace label")}</span>
          </label>}
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          {/* a listed folder picked: open it as a workspace (its chats as tabs), or still make a new chat there */}
          {opensWorkspace && <button type="button" className="btn" disabled={pending} onClick={() => onOpenHostWorkspace?.(cwd)}>{t("Open workspace")}</button>}
          <button type="submit" className="btn btn-primary" disabled={pending || (hostChoice && ((tab?.cwd ?? cwd).trim() === "" || !hostFields.current?.ready()))}>{t(pending ? "Starting…" : opensWorkspace ? "New chat" : createdPaneId !== null ? "Open" : "Start")}</button>
        </footer>
      </form>
    </div>
  );
}
