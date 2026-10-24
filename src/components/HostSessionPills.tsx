/**
 * A host chat's session pills, above its composer as VS Code puts them (agentHostSessionInputPills,
 * 1.142): one pill per kind, in VS Code's order: the chat's Changes ("N files +A −R", its files and
 * their diffs), Pull Requests, Issues, Artifacts, References, Subagents and Shells. A kind with one
 * entry shows it inline (a PR as `#12` in its state's colour, a file by its name) and a tap opens
 * it; with several, the count, in the group's most pressing state, and a tap opens their sheet.
 * A shell is stoppable where the host allows it, a subagent taken to its row. Read-only otherwise.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import {
  Bot, ChevronRight, CircleCheck, CircleDot, CircleSlash, Copy, FileDiff, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed,
  GitPullRequestDraft, Globe, Link, Package, SquareTerminal, X, type LucideProps,
} from "lucide-react";

import type { HostArtifact, HostArtifactType, HostBackgroundWork, HostChangedFile, HostChanges, HostEditDiff } from "../../shared/host-chats.ts";
import { artifactLook, groupState, pathOfFileUri, sessionPills, shortLabel, type ArtifactIcon, type ReferenceState } from "../lib/artifacts.ts";
import { copyText } from "../lib/clipboard.ts";

import { useT } from "../lib/i18n.ts";
import { fetchHostChangeDiff, fetchHostChanges, fetchReferenceStates } from "../lib/hostChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { DiffBody } from "./ChatView.tsx";
import { FileGlyph } from "./FileGlyph.tsx";
import type { SubagentTarget } from "./SubagentRow.tsx";

const ICONS: Record<ArtifactIcon, ComponentType<LucideProps>> = {
  "pr-open": GitPullRequest, "pr-attention": GitPullRequest, "pr-draft": GitPullRequestDraft, "pr-merged": GitMerge, "pr-closed": GitPullRequestClosed,
  "issue-open": CircleDot, "issue-done": CircleCheck, "issue-not-planned": CircleSlash,
  commit: GitCommitHorizontal, website: Globe, file: Package, resource: Link,
};

const SECTION_TITLE: Record<HostArtifactType, string> = {
  pullRequest: "Pull requests", issue: "Issues", commit: "Commits", website: "Websites", file: "Files", resource: "Resources",
};

const isWeb = (link: string | undefined): link is string => link !== undefined && /^https?:\/\//i.test(link);

function ArtifactGlyph({ artifact, state }: { artifact: HostArtifact; state?: ReferenceState }) {
  const look = artifactLook(artifact, state);
  if (artifact.type === "file") {
    const path = artifact.uri ? pathOfFileUri(artifact.uri) : null;
    return <FileGlyph name={(path ?? artifact.label).split("/").pop() ?? artifact.label} className="session-pill-icon" />;
  }
  const Icon = ICONS[look.icon];
  return <Icon className="session-pill-icon" data-tone={look.tone} aria-hidden="true" />;
}

export interface HostSessionPillsProps {
  artifacts: readonly HostArtifact[];
  work: readonly HostBackgroundWork[];
  /** opens a file of the chat's PC in herdr's viewer */
  onOpenFile(path: string): void;
  onStop(id: string): Promise<void>;
  /** takes the reader to a running subagent's row in the transcript; false when no loaded turn holds it */
  onRevealSubagent?(target: SubagentTarget): boolean;
  /** where PR and issue states and the chat's changes are asked; absent: neither */
  machineId?: string;
  /** the chat whose changeset the Changes pill counts */
  session?: string;
  /** changes when the changes may have: a turn ended, another began (the count is read again) */
  changesKey?: string;
  /** an answer's "View" (ZAC-228): open the Changes sheet cut to these paths; `at` makes each tap a new request */
  showChanges?: { paths: string[]; at: number } | null;
}

type Sheet = "changes" | "pullRequests" | "issues" | "artifacts" | "references" | "subagents" | "shells";

export function HostSessionPills({ artifacts, work, onOpenFile, onStop, onRevealSubagent, machineId, session, changesKey, showChanges = null }: HostSessionPillsProps) {
  const t = useT();
  const pills = useMemo(() => sessionPills(artifacts), [artifacts]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const states = useReferenceStates(machineId, [...pills.pullRequests, ...pills.issues, ...pills.sections.flatMap((section) => section.items)]);
  const changes = useHostChanges(machineId, session, changesKey);
  const [only, setOnly] = useState<string[] | null>(null);
  const close = useCallback(() => { setSheet(null); setOnly(null); }, []);
  useEffect(() => {
    if (showChanges === null) return;
    setOnly(showChanges.paths);
    setSheet("changes");
  }, [showChanges]);
  const open = (artifact: HostArtifact): void => {
    if (artifact.type === "file" && artifact.uri) {
      const path = pathOfFileUri(artifact.uri);
      if (path !== null) { onOpenFile(path); return; }
    }
    const link = artifact.link ?? artifact.uri;
    if (isWeb(link)) { window.open(link, "_blank", "noopener,noreferrer"); return; }
    if (artifact.commitHash) void copyText(artifact.commitHash);
  };
  const others = pills.sections.flatMap((section) => section.items);
  const subagents = work.filter((each) => each.kind === "subagent");
  const shells = work.filter((each) => each.kind === "shell");
  const shownChanges = changes !== null && changes.files.length > 0 ? changes : null;
  // a sheet whose last entry went (the shell stopped, the subagent ended) closes with its pill
  const emptied = (sheet === "shells" && shells.length === 0) || (sheet === "subagents" && subagents.length === 0) || (sheet === "changes" && shownChanges === null);
  useEffect(() => { if (emptied) setSheet(null); }, [emptied]);
  if (shownChanges === null && pills.pullRequests.length + pills.issues.length + others.length + pills.references.length + work.length === 0) return null;
  const sheetPill = (kind: Sheet, icon: React.ReactNode, label: string, extra: { running?: boolean; aria?: string; title?: string; children?: React.ReactNode } = {}) =>
    <button key={kind} type="button" className={`session-pill${extra.running ? " is-running" : ""}`} aria-haspopup="dialog" aria-expanded={sheet === kind}
      {...(extra.aria ? { "aria-label": extra.aria } : {})} title={extra.title ?? label} onClick={() => { setOnly(null); setSheet(kind); }}>
      {icon}
      <span className="session-pill-label">{label}</span>
      {extra.children}
    </button>;
  // one entry of a kind is the pill itself: a tap opens it, as VS Code's single-entry pill does
  const group = (kind: "pullRequests" | "issues" | "artifacts" | "references", items: HostArtifact[], many: string) => {
    if (items.length === 0) return null;
    if (items.length === 1) {
      const artifact = items[0]!;
      const short = kind === "pullRequests" || kind === "issues" ? shortLabel(artifact) : artifact.label;
      return <button key={kind} type="button" className="session-pill" title={artifact.label} onClick={() => open(artifact)}>
        <ArtifactGlyph artifact={artifact} state={artifact.link ? states[artifact.link] : undefined} />
        <span className="session-pill-label">{short}</span>
      </button>;
    }
    const first = items[0]!;
    const state = kind === "pullRequests" || kind === "issues" ? groupState(items.map((each) => states[each.link!] ?? "unknown")) : undefined;
    const icon = kind === "artifacts" ? <Package className="session-pill-icon" aria-hidden="true" />
      : kind === "references" ? <Link className="session-pill-icon" aria-hidden="true" />
        : <ArtifactGlyph artifact={first} state={state} />;
    return sheetPill(kind, icon, many);
  };
  return <div className="session-pills" role="toolbar" aria-label={t("Session")}>
    {shownChanges !== null && sheetPill("changes", <FileDiff className="session-pill-icon" aria-hidden="true" />,
      t(shownChanges.files.length === 1 ? "1 file" : "{n} files", { n: shownChanges.files.length }), {
        aria: t("{label}: {n} files, {added} added, {removed} removed", { label: shownChanges.label, n: shownChanges.files.length, added: shownChanges.added, removed: shownChanges.removed }),
        title: shownChanges.label,
        children: <Stat added={shownChanges.added} removed={shownChanges.removed} />,
      })}
    {group("pullRequests", pills.pullRequests, t("{n} pull requests", { n: pills.pullRequests.length }))}
    {group("issues", pills.issues, t("{n} issues", { n: pills.issues.length }))}
    {group("artifacts", others, t("{n} artifacts", { n: others.length }))}
    {group("references", pills.references, t("{n} references", { n: pills.references.length }))}
    {subagents.length > 0 && sheetPill("subagents", <Bot className="session-pill-icon" aria-hidden="true" />,
      t(subagents.length === 1 ? "1 subagent" : "{n} subagents", { n: subagents.length }), { running: true })}
    {shells.length > 0 && sheetPill("shells", <SquareTerminal className="session-pill-icon" aria-hidden="true" />,
      t(shells.length === 1 ? "1 shell" : "{n} shells", { n: shells.length }), { running: true })}
    {sheet === "changes" && shownChanges !== null && machineId !== undefined && session !== undefined && <PillSheet title={shownChanges.label} onClose={close}>
      <ChangesList changes={only === null ? shownChanges : onlyPaths(shownChanges, only)} load={(id, signal) => fetchHostChangeDiff(machineId, session, id, signal)} onOpenFile={onOpenFile} />
    </PillSheet>}
    {sheet === "pullRequests" && <PillSheet title={t("Pull requests")} onClose={close}><ArtifactList items={pills.pullRequests} states={states} onOpen={open} /></PillSheet>}
    {sheet === "issues" && <PillSheet title={t("Issues")} onClose={close}><ArtifactList items={pills.issues} states={states} onOpen={open} /></PillSheet>}
    {sheet === "artifacts" && <PillSheet title={t("Artifacts")} onClose={close}>
      {pills.sections.map((section) => <ArtifactList key={section.type} title={t(SECTION_TITLE[section.type])} items={section.items} states={states} onOpen={open} />)}
    </PillSheet>}
    {sheet === "references" && <PillSheet title={t("References")} onClose={close}><ArtifactList items={pills.references} states={states} onOpen={open} /></PillSheet>}
    {(sheet === "subagents" || sheet === "shells") && <PillSheet title={t(sheet === "subagents" ? "Subagents" : "Shells")} onClose={close}>
      <WorkList work={sheet === "subagents" ? subagents : shells} onStop={onStop} {...(onRevealSubagent ? { onReveal: (target: SubagentTarget) => {
        const shown = onRevealSubagent(target);
        if (shown) setSheet(null);
        return shown;
      } } : {})} />
    </PillSheet>}
  </div>;
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return <span className="session-pill-stat" aria-hidden="true">
    <span className="session-pill-added">+{added}</span>
    <span className="session-pill-removed">−{removed}</span>
  </span>;
}

/** The chat's changes cut to an answer's files (ZAC-228); the sums are the cut's own. */
export function onlyPaths(changes: HostChanges, paths: readonly string[]): HostChanges {
  const wanted = new Set(paths);
  const files = changes.files.filter((file) => wanted.has(file.path));
  return { ...changes, files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) };
}

/** The changeset's files, VS Code's Changes list: each one's name, folder and lines; a tap opens its diff under it. */
function ChangesList({ changes, load, onOpenFile }: { changes: HostChanges; load(id: string, signal: AbortSignal): Promise<HostEditDiff>; onOpenFile(path: string): void }) {
  const t = useT();
  const [opened, setOpened] = useState<string | null>(null);
  return <>
    <p className="session-sheet-summary">{t(changes.files.length === 1 ? "1 file" : "{n} files", { n: changes.files.length })} <Stat added={changes.added} removed={changes.removed} /></p>
    <ul className="session-sheet-list">{changes.files.map((file) => <ChangedFile key={file.id} file={file} open={opened === file.id}
      onToggle={() => setOpened((current) => current === file.id ? null : file.id)} load={load} onOpenFile={onOpenFile} />)}</ul>
  </>;
}

function ChangedFile({ file, open, onToggle, load, onOpenFile }: { file: HostChangedFile; open: boolean; onToggle(): void; load(id: string, signal: AbortSignal): Promise<HostEditDiff>; onOpenFile(path: string): void }) {
  const t = useT();
  const name = file.path.split("/").pop() ?? file.path;
  const folder = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
  const loader = useCallback((signal: AbortSignal) => load(file.id, signal), [load, file.id]);
  const note = file.kind === "create" ? t("Created") : file.kind === "delete" ? t("Deleted") : file.kind === "rename" ? t("Renamed") : null;
  return <li className="session-sheet-item">
    <button type="button" className="session-sheet-row" aria-expanded={open} onClick={onToggle}>
      <FileGlyph name={name} className="session-pill-icon" />
      <span className="session-sheet-text">
        <span className="session-sheet-label">{name}{note && <span className="session-sheet-kind"> · {note}</span>}</span>
        {folder && <span className="session-sheet-detail">{folder}</span>}
      </span>
      <Stat added={file.added} removed={file.removed} />
      <ChevronRight className="session-sheet-go session-sheet-chevron" aria-hidden="true" />
    </button>
    {open && <DiffBody load={loader} onOpen={file.kind === "delete" ? null : () => onOpenFile(file.path)} />}
  </li>;
}

/** The chat's changes, read on mount and again whenever `key` moves (a turn ends); null until then or without any. */
function useHostChanges(machineId: string | undefined, session: string | undefined, key: string | undefined): HostChanges | null {
  const [changes, setChanges] = useState<HostChanges | null>(null);
  useEffect(() => {
    if (machineId === undefined || session === undefined) return;
    const abort = new AbortController();
    fetchHostChanges(machineId, session, abort.signal).then((answer) => { if (!abort.signal.aborted) setChanges(answer); }, () => undefined);
    return () => abort.abort();
  }, [machineId, session, key]);
  return changes;
}

function ArtifactList({ title, items, states, onOpen }: { title?: string; items: HostArtifact[]; states: Record<string, ReferenceState>; onOpen(artifact: HostArtifact): void }) {
  const t = useT();
  return <section className="session-sheet-section">
    {title !== undefined && <h3 className="session-sheet-heading">{title}</h3>}
    <ul className="session-sheet-list">{items.map((artifact) => {
      const openable = artifact.type === "file" ? artifact.uri !== undefined : isWeb(artifact.link ?? artifact.uri) || artifact.commitHash !== undefined;
      const detail = artifact.type === "commit" ? artifact.commitHash?.slice(0, 7) : artifact.type === "file" && artifact.uri ? pathOfFileUri(artifact.uri) ?? undefined : hostOf(artifact.link ?? artifact.uri);
      return <li key={artifact.id} className="session-sheet-item">
        <button type="button" className="session-sheet-row" disabled={!openable} onClick={() => onOpen(artifact)}
          title={artifact.type === "commit" && !artifact.link ? t("Copy the commit's hash") : undefined}>
          <ArtifactGlyph artifact={artifact} state={artifact.link ? states[artifact.link] : undefined} />
          <span className="session-sheet-text">
            <span className="session-sheet-label">{artifact.label}</span>
            {detail && <span className="session-sheet-detail">{detail}</span>}
          </span>
          {artifact.type === "commit" && !artifact.link && <Copy className="session-sheet-aside" aria-hidden="true" />}
        </button>
      </li>;
    })}</ul>
  </section>;
}

function hostOf(link: string | undefined): string | undefined {
  if (!isWeb(link)) return undefined;
  try { return new URL(link).host; } catch { return undefined; }
}

function WorkList({ work, onStop, onReveal }: { work: readonly HostBackgroundWork[]; onStop(id: string): Promise<void>; onReveal?(target: SubagentTarget): boolean }) {
  const t = useT();
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [unseen, setUnseen] = useState<string | null>(null);
  const stop = (id: string): void => {
    setStopping((current) => new Set(current).add(id));
    setFailed(null);
    onStop(id).catch(() => setFailed(id)).finally(() => setStopping((current) => { const next = new Set(current); next.delete(id); return next; }));
  };
  return <ul className="session-sheet-list">{work.map((each) => {
    const Icon = each.kind === "shell" ? SquareTerminal : Bot;
    const label = each.label || (each.kind === "shell" ? t("Background command") : t("Subagent"));
    const text = <span className="session-sheet-text">
      <span className="session-sheet-label">{label}</span>
      {each.kind === "shell" && each.command && each.command !== each.label && <code className="session-sheet-detail">{each.command}</code>}
      {failed === each.id && <span className="session-sheet-error" role="alert">{t("Couldn't stop it")}</span>}
      {unseen === each.id && <span className="session-sheet-error" role="alert">{t("Its turn isn't loaded: scroll up to it")}</span>}
    </span>;
    // a subagent goes to its row in the transcript, opened, as VS Code's running list does
    const target: SubagentTarget | undefined = each.kind === "subagent" && onReveal && (each.chat !== undefined || each.toolCall !== undefined)
      ? { ...(each.chat !== undefined ? { chat: each.chat } : {}), ...(each.toolCall !== undefined ? { toolCall: each.toolCall } : {}) } : undefined;
    return <li key={each.id} className="session-sheet-item">
      {target !== undefined
        ? <button type="button" className="session-sheet-row" onClick={() => { setUnseen(onReveal!(target) ? null : each.id); }}>
          <Icon className="session-pill-icon" aria-hidden="true" />
          {text}
          <ChevronRight className="session-sheet-go" aria-hidden="true" />
        </button>
        : <div className="session-sheet-row is-static">
          <Icon className="session-pill-icon" aria-hidden="true" />
          {text}
          {each.stoppable && <button type="button" className="btn btn-ghost session-sheet-stop" disabled={stopping.has(each.id)} onClick={() => stop(each.id)}>
            {stopping.has(each.id) ? t("Stopping…") : t("Stop")}
          </button>}
        </div>}
    </li>;
  })}</ul>;
}

function PillSheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const t = useT();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal session-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Each PR and issue link's state, asked once per set of links; unknown until it answers, or when it fails. */
function useReferenceStates(machineId: string | undefined, artifacts: HostArtifact[]): Record<string, ReferenceState> {
  const links = [...new Set(artifacts.filter((each) => (each.type === "pullRequest" || each.type === "issue") && isWeb(each.link)).map((each) => each.link!))].sort();
  const key = links.join("\n");
  const [states, setStates] = useState<Record<string, ReferenceState>>({});
  useEffect(() => {
    if (machineId === undefined || links.length === 0) return;
    const abort = new AbortController();
    fetchReferenceStates(links, abort.signal).then((answer) => { if (!abort.signal.aborted) setStates(answer); }, () => undefined);
    return () => abort.abort();
    // the links' key stands for the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, key]);
  return states;
}
