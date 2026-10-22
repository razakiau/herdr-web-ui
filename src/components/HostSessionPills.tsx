/**
 * A host chat's session pills, above its composer as VS Code puts them (agentHostSessionInputPills):
 * each GitHub PR and issue the session produced, in its state's colour; "N artifacts", whose sheet
 * lists the rest by kind and the references after them; and "N running" for the chat's background
 * shells and subagents, a shell stoppable where the host allows it. Read-only otherwise.
 */
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import {
  Bot, ChevronRight, CircleCheck, CircleDot, CircleSlash, Copy, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed,
  GitPullRequestDraft, Globe, Link, Package, SquareTerminal, X, type LucideProps,
} from "lucide-react";

import type { HostArtifact, HostArtifactType, HostBackgroundWork } from "../../shared/host-chats.ts";
import { artifactLook, pathOfFileUri, sessionPills, shortLabel, type ArtifactIcon, type ReferenceState } from "../lib/artifacts.ts";
import { copyText } from "../lib/clipboard.ts";

import { useT } from "../lib/i18n.ts";
import { fetchReferenceStates } from "../lib/hostChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { FileGlyph } from "./FileGlyph.tsx";

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
  onRevealSubagent?(chat: string): boolean;
  /** where PR and issue states are asked; absent: every one shows its kind's neutral icon */
  machineId?: string;
}

export function HostSessionPills({ artifacts, work, onOpenFile, onStop, onRevealSubagent, machineId }: HostSessionPillsProps) {
  const t = useT();
  const pills = useMemo(() => sessionPills(artifacts), [artifacts]);
  const [sheet, setSheet] = useState<"artifacts" | "work" | null>(null);
  const states = useReferenceStates(machineId, [...pills.pullRequests, ...pills.issues, ...pills.sections.flatMap((section) => section.items)]);
  const open = (artifact: HostArtifact): void => {
    if (artifact.type === "file" && artifact.uri) {
      const path = pathOfFileUri(artifact.uri);
      if (path !== null) { onOpenFile(path); return; }
    }
    const link = artifact.link ?? artifact.uri;
    if (isWeb(link)) { window.open(link, "_blank", "noopener,noreferrer"); return; }
    if (artifact.commitHash) void copyText(artifact.commitHash);
  };
  if (pills.pullRequests.length + pills.issues.length + pills.count + pills.references.length + work.length === 0) return null;
  const shells = work.filter((each) => each.kind === "shell").length;
  const RunIcon = shells > 0 ? SquareTerminal : Bot;
  return <div className="session-pills" role="toolbar" aria-label={t("Session")}>
    {[...pills.pullRequests, ...pills.issues].map((artifact) => <button key={artifact.id} type="button" className="session-pill" title={artifact.label} onClick={() => open(artifact)}>
      <ArtifactGlyph artifact={artifact} state={states[artifact.link!]} />
      <span className="session-pill-label">{shortLabel(artifact)}</span>
    </button>)}
    {(pills.count > 0 || pills.references.length > 0) && <button type="button" className="session-pill" aria-haspopup="dialog" aria-expanded={sheet === "artifacts"} onClick={() => setSheet("artifacts")}>
      <Package className="session-pill-icon" aria-hidden="true" />
      <span className="session-pill-label">{pills.count > 0
        ? t(pills.count === 1 ? "1 artifact" : "{n} artifacts", { n: pills.count })
        : t(pills.references.length === 1 ? "1 reference" : "{n} references", { n: pills.references.length })}</span>
    </button>}
    {work.length > 0 && <button type="button" className="session-pill is-running" aria-haspopup="dialog" aria-expanded={sheet === "work"} onClick={() => setSheet("work")}>
      <RunIcon className="session-pill-icon" aria-hidden="true" />
      <span className="session-pill-label">{t("{n} running", { n: work.length })}</span>
    </button>}
    {sheet === "artifacts" && <PillSheet title={t("Artifacts")} onClose={() => setSheet(null)}>
      {pills.sections.map((section) => <ArtifactList key={section.type} title={t(SECTION_TITLE[section.type])} items={section.items} states={states} onOpen={open} />)}
      {pills.references.length > 0 && <ArtifactList title={t("References")} items={pills.references} states={states} onOpen={open} />}
    </PillSheet>}
    {sheet === "work" && <PillSheet title={t("Running in the background")} onClose={() => setSheet(null)}>
      <WorkList work={work} onStop={onStop} {...(onRevealSubagent ? { onReveal: (chat: string) => {
        const shown = onRevealSubagent(chat);
        if (shown) setSheet(null);
        return shown;
      } } : {})} />
    </PillSheet>}
  </div>;
}

function ArtifactList({ title, items, states, onOpen }: { title: string; items: HostArtifact[]; states: Record<string, ReferenceState>; onOpen(artifact: HostArtifact): void }) {
  const t = useT();
  return <section className="session-sheet-section">
    <h3 className="session-sheet-heading">{title}</h3>
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

function WorkList({ work, onStop, onReveal }: { work: readonly HostBackgroundWork[]; onStop(id: string): Promise<void>; onReveal?(chat: string): boolean }) {
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
    const chat = each.kind === "subagent" && onReveal ? each.chat : undefined;
    return <li key={each.id} className="session-sheet-item">
      {chat !== undefined
        ? <button type="button" className="session-sheet-row" onClick={() => { setUnseen(onReveal!(chat) ? null : each.id); }}>
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
