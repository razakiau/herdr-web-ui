/**
 * Chat groups (ZAC-265), one group's page (owner's option E, v2 polish): one scrolling page. Its
 * header names the group, "N chats · 1 working · 1 warm · <first date> – now · ~$cost" and a ⋯
 * (Rename, Delete). The digest card's place comes next (Task 9 fills it). Then the chats as a tree
 * of who started whom (lib/groups.ts groupTree), any depth (a phone indents two levels, deeper ones
 * keep the second's indent): each is the app's own agent row, as All agents draws it (AgentRowBody
 * with the cache ring and keep-warm flame, the status glyph and its time, the cost cell), under one
 * line saying how it got there ("Started by 262 · Nov 1"), and its summary when it has one. The chat
 * the page was opened from is the selected row. Then the artifacts in chips by kind, each opening
 * its list as the chat's sheets list them (HostSessionPills.tsx ArtifactList: live PR and issue
 * colours, file glyphs), each credited to the first chat that has it (lib/groups.ts
 * creditArtifacts), five shown, then "Show N more". They are read from each chat's own read when
 * the page opens, a PC that is offline not asked. A tap on a row opens the chat, an archived one
 * too. A chat whose PC is offline says "PC offline", one its PC no longer lists "gone".
 */
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, CircleDot, Ellipsis, GitCommitHorizontal, GitPullRequest, Globe, Link, Package, Pencil, Trash2, type LucideProps } from "lucide-react";

import "./NewSessionDialog.css";
import "./Sidebar.css";
import "./AgentSidebar.css";
import "./AllAgentsSheet.css";
import "./SessionSheet.css";
import "./HostChatView.css";
import "./GroupsSheet.css";
import "./GroupTrail.css";
import "./GroupPage.css";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostArtifact, HostArtifactType, HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import { listUsd } from "../lib/chatCost.ts";
import { pathOfFileUri } from "../lib/artifacts.ts";
import { copyText } from "../lib/clipboard.ts";
import { chatKey, costOf, creditArtifacts, defaultFolds, groupsApi, groupTree, rerootTree, shortChatName, treeLines, type ChatRef, type TreeLine, type TreeNode } from "../lib/groups.ts";
import { hostChatStatus } from "../lib/hostPlacement.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { basename, chatAge, fetchHostChat, type HostPc } from "../lib/hostChats.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { daysBack } from "../lib/hostChatGroups.ts";
import type { CostsFeed } from "../lib/rowCache.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { CostSplit } from "../lib/sessionCost.ts";
import { AgentRowBody, cacheWords } from "./AgentSidebar.tsx";
import { RowCostCell } from "./AllAgentsSheet.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { GroupNameSheet, rowsByKey, shortDate } from "./GroupsSheet.tsx";
import { GroupStateSummary, hasGroupState, useMemberStates } from "./GroupState.tsx";
import { ArtifactList, useReferenceStates } from "./HostSessionPills.tsx";
import { RowMenu } from "./RowMenu.tsx";

export interface GroupPageProps {
  group: ChatGroup;
  answer: GroupsAnswer;
  machines: readonly Machine[];
  hostChats: ReadonlyMap<string, HostPc>;
  /** each chat's cost by chatKey (lib/groups.ts chatCosts) */
  costs?: ReadonlyMap<string, CostSplit>;
  /** the page's costs feed (lib/rowCache.ts), for each row's cache ring as the sidebar draws it; null while costs are not tracked */
  feed?: CostsFeed | null;
  /** the chat the page was opened from: its row is the selected one */
  from?: ChatRef | null;
  onOpenChat(target: { machineId: string; session: string }): void;
  /** a file artifact, in herdr's viewer on its chat's PC */
  onOpenFile?(target: { machineId: string; path: string }): void;
  onClose(): void;
}

const NO_COSTS: ReadonlyMap<string, CostSplit> = new Map();

/** The artifact kinds in the order the chips name them, with their icon and their words. */
const KINDS: { type: HostArtifactType; icon: ComponentType<LucideProps>; label(n: number, t: Translate): string }[] = [
  { type: "pullRequest", icon: GitPullRequest, label: (n, t) => n === 1 ? t("1 pull request") : t("{n} pull requests", { n }) },
  { type: "issue", icon: CircleDot, label: (n, t) => n === 1 ? t("1 issue") : t("{n} issues", { n }) },
  { type: "file", icon: Package, label: (n, t) => n === 1 ? t("1 file") : t("{n} files", { n }) },
  { type: "commit", icon: GitCommitHorizontal, label: (n, t) => n === 1 ? t("1 commit") : t("{n} commits", { n }) },
  { type: "website", icon: Globe, label: (n, t) => n === 1 ? t("1 website") : t("{n} websites", { n }) },
  { type: "resource", icon: Link, label: (n, t) => n === 1 ? t("1 resource") : t("{n} resources", { n }) },
];

/** What a group shows of a chat's artifacts: what it made, and the PRs and issues it names (the session pills' rule, lib/artifacts.ts). */
const shownArtifact = (artifact: HostArtifact): boolean => artifact.isArtifact || artifact.type === "pullRequest" || artifact.type === "issue";

/** How many chat reads the page has in flight at once: each is a full read of a chat. */
export const ARTIFACT_READS = 3;
/** How long one artifact read may take before it gives up its place (a PC that hangs never answers). */
export const ARTIFACT_READ_TIMEOUT_MS = 20_000;

/**
 * Each member's artifacts, read from its chat's read as the page opens, at most ARTIFACT_READS at a
 * time. A member read once is not read again (a nudge or a PC reconnecting re-renders, it does not
 * re-read); a chat that joins is read, one that leaves takes its artifacts with it. A PC that is not
 * connected is not asked, and a failed or timed-out read (ARTIFACT_READ_TIMEOUT_MS) is none.
 */
function useMemberArtifacts(group: ChatGroup, machines: readonly Machine[]): Map<string, HostArtifact[]> {
  const [found, setFound] = useState<Map<string, HostArtifact[]>>(() => new Map());
  const reads = useRef({ asked: new Set<string>(), queue: [] as string[], active: 0, live: true });
  const online = (pc: string): boolean => machines.find((machine) => machine.id === pc)?.state === "connected";
  const members = group.members.filter((member) => online(member.pc)).map((member) => chatKey(member.pc, member.session)).join("\n");
  const all = group.members.map((member) => chatKey(member.pc, member.session)).join("\n");
  useEffect(() => {
    const state = reads.current;
    state.live = true;
    return () => { state.live = false; };
  }, []);
  useEffect(() => {
    const state = reads.current;
    const now = new Set(all === "" ? [] : all.split("\n"));
    // a chat that left: forgotten, so that it is read again should it come back
    for (const key of [...state.asked]) if (!now.has(key)) state.asked.delete(key);
    state.queue = state.queue.filter((key) => now.has(key));
    setFound((current) => [...current.keys()].every((key) => now.has(key)) ? current : new Map([...current].filter(([key]) => now.has(key))));
    for (const key of members === "" ? [] : members.split("\n")) {
      if (state.asked.has(key)) continue;
      state.asked.add(key);
      state.queue.push(key);
    }
    const pump = (): void => {
      while (state.live && state.active < ARTIFACT_READS && state.queue.length > 0) {
        const key = state.queue.shift()!;
        const at = key.indexOf(" ");
        state.active += 1;
        fetchHostChat(key.slice(0, at), key.slice(at + 1), undefined, AbortSignal.timeout(ARTIFACT_READ_TIMEOUT_MS)).then((read) => {
          if (state.live && state.asked.has(key)) setFound((current) => new Map(current).set(key, (read.artifacts ?? []).filter(shownArtifact)));
        }, () => { /* the chat is still drawn; it shows no artifacts */ }).finally(() => {
          state.active -= 1;
          pump();
        });
      }
    };
    pump();
  }, [members, all]);
  // a read that lands after its chat left is not shown either
  return useMemo(() => {
    const now = new Set(all === "" ? [] : all.split("\n"));
    return new Map([...found].filter(([key]) => now.has(key)));
  }, [found, all]);
}

/** A day as the relation line says it: "today", "Oct 29". */
const dayOf = (at: number, now: number, locale: string, t: Translate): string => daysBack(at, now) <= 0 ? t("today") : shortDate(at, locale);

/** How many of a kind's artifacts show before "Show N more". */
export const ARTIFACTS_SHOWN = 5;

/** How a chat got into the tree, in plain words: "The first chat", "Started by 262", "Added by you". */
function relation(node: TreeNode, name: (session: string) => string, t: Translate): string {
  switch (node.join.kind) {
    case "first": return t("The first chat");
    case "manual": return t("Added by you");
    case "spawn": case "job": return t("Started by {name}", { name: name(node.join.from) });
    case "continue": return t("Continued from {name}", { name: name(node.join.from) });
    case "resume": return t("Resumed from {name}", { name: name(node.join.from) });
    case "fork": return t("Forked from {name}", { name: name(node.join.from) });
  }
}

export function GroupPage({ group, answer, machines, hostChats, costs = NO_COSTS, feed = null, from = null, onOpenChat, onOpenFile, onClose }: GroupPageProps) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [asking, setAsking] = useState<"rename" | "delete" | null>(null);
  const [kind, setKind] = useState<HostArtifactType | null>(null);
  const [more, setMore] = useState(false);
  // the branches the owner folded or opened (by the chat at their top), over the default folds
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  // the "Continue this thread"s opened, in turn: the page shows the last one's branch, a breadcrumb back up
  const [roots, setRoots] = useState<readonly string[]>([]);
  const root = roots.at(-1) ?? null;
  // a breadcrumb's chat: back to where it was opened, else (a chat above the first continue) a new step
  const goTo = (key: string | null): void => setRoots((last) => {
    if (key === null) return [];
    const at = last.indexOf(key);
    return at >= 0 ? last.slice(0, at + 1) : [key];
  });
  // Reddit's thread (owner's round 2): 3 levels on a phone, 5 wider, then "Continue this thread"
  const cap = useMediaQuery("(max-width: 519px)") ? 3 : 5;
  const page = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: page });
  const tree = useMemo(() => groupTree(group, answer.links), [group, answer.links]);
  const shown = useMemo(() => rerootTree(tree, root), [tree, root]);
  // Back (and the header's ‹, and Escape) goes up a level first (to where the thread was continued), then closes
  const back = (): boolean => { if (root !== null) { setRoots((last) => last.slice(0, -1)); return false; } onClose(); return true; };
  usePhoneSheetBack(back, menu === null && asking === null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || menu !== null || asking !== null || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      back();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  const { states, now } = useMemberStates(group, rows, feed);
  const artifacts = useMemberArtifacts(group, machines);
  const credited = useMemo(() => creditArtifacts(artifacts, tree.map((node) => chatKey(node.pc, node.session))), [artifacts, tree]);
  const machineOf = (pc: string): Machine | undefined => machines.find((machine) => machine.id === pc);
  const rowOf = (ref: { pc: string; session: string }): HostChatRow | undefined => rows.get(chatKey(ref.pc, ref.session));
  const titleOf = (ref: { pc: string; session: string }): string => rowOf(ref)?.title.trim() || t("Copilot chat");
  const keys = group.members.map((member) => chatKey(member.pc, member.session));
  const total = costOf(keys, costs);
  const times = group.members.map((member) => Date.parse(rows.get(chatKey(member.pc, member.session))?.modified_at ?? "")).filter(Number.isFinite);
  const first = Math.min(Date.parse(group.createdAt) || now, ...times);
  const count = group.members.length;
  const shownStates = [...states.values()];
  const summaries = new Map(answer.summaries.map((summary) => [chatKey(summary.pc, summary.session), summary.text]));
  const chips = KINDS.map((each) => ({ ...each, items: credited.filter((entry) => entry.artifact.type === each.type) })).filter((each) => each.items.length > 0);
  const listed = kind === null ? [] : chips.find((each) => each.type === kind)?.items ?? [];
  const shownListed = more ? listed : listed.slice(0, ARTIFACTS_SHOWN);
  // the PR and issue states, asked of this server as the chat's pills ask them (any connected PC stands for the page)
  const anyPc = machines.find((machine) => machine.state === "connected")?.id;
  const references = useMemo(() => credited.map((entry) => entry.artifact), [credited]);
  const referenceStates = useReferenceStates(anyPc, references);
  const creditOf = new Map(credited.map((entry) => [entry.artifact, entry.from]));
  const pcNames = new Set(group.members.map((member) => member.pc)).size > 1;
  const openArtifact = (artifact: HostArtifact): void => {
    const key = creditOf.get(artifact);
    if (artifact.type === "file" && artifact.uri && key !== undefined && onOpenFile) {
      const path = pathOfFileUri(artifact.uri);
      if (path !== null) { onOpenFile({ machineId: key.slice(0, key.indexOf(" ")), path }); return; }
    }
    const link = artifact.link ?? artifact.uri;
    if (link !== undefined && /^https?:\/\//i.test(link)) { window.open(link, "_blank", "noopener,noreferrer"); return; }
    if (artifact.commitHash) void copyText(artifact.commitHash);
  };
  const canOpen = (artifact: HostArtifact): boolean => artifact.type === "file" ? artifact.uri !== undefined && onOpenFile !== undefined
    : /^https?:\/\//i.test(artifact.link ?? artifact.uri ?? "") || artifact.commitHash !== undefined;
  // a branch all archived and cold folds by default (the chat the page was opened from never does)
  const quiet = (key: string): boolean => {
    const row = rows.get(key);
    const mark = states.get(key)?.mark ?? null;
    return row?.archived === true && (mark === null || mark.state === "cold") && !(from !== null && chatKey(from.pc, from.session) === key);
  };
  const folds = new Set(defaultFolds(shown.nodes, quiet));
  for (const [key, on] of toggled) { if (on) folds.add(key); else folds.delete(key); }
  const lines = treeLines(shown.nodes, folds, cap);
  const toggle = (key: string): void => setToggled((last) => new Map(last).set(key, !folds.has(key)));
  const nameOfNode = (node: TreeNode): string => shortChatName(titleOf(node));
  const nameOfKey = (key: string): string => { const at = key.indexOf(" "); return shortChatName(titleOf({ pc: key.slice(0, at), session: key.slice(at + 1) })); };

  const member = (line: TreeLine) => {
    const { node } = line;
    const key = chatKey(node.pc, node.session);
    const row = rowOf(node);
    const machine = machineOf(node.pc);
    const offline = machine?.state !== "connected";
    const pc = hostChats.get(node.pc);
    const gone = !offline && row === undefined && pc !== undefined && pc.stale !== true;
    const cost = costs.get(key);
    const state = states.get(key);
    const mark = state?.mark ?? null;
    const title = titleOf(node);
    const selected = from !== null && from.pc === node.pc && from.session === node.session;
    // the second line as All agents': why it is not there, archived (All agents says it by its section, a tree in words), its folder, its age, then its cache in words
    const parts = [row?.status === "error" ? t("Error") : null, offline ? t("PC offline") : gone ? t("gone") : null, row?.archived ? t("Archived") : null,
      row?.cwd ? basename(row.cwd) : null, row ? chatAge(row, now, t) : null].filter((part): part is string => Boolean(part));
    // the cache is the ring round the mark, as All agents' rows say it (round 3): no words or dot for it again
    const context = parts.join(" · ");
    const relationText = relation(node, (session) => shortChatName(titleOf({ pc: node.pc, session })), t);
    const at = Date.parse(node.join.at);
    const summary = summaries.get(key);
    const hiddenStates = line.hidden.map((each) => states.get(chatKey(each.pc, each.session))).filter((each): each is NonNullable<typeof each> => each !== undefined);
    const hiddenCount = line.hidden.length;
    const relationLine = <>{relationText}{Number.isFinite(at) && node.join.kind !== "first" ? ` · ${dayOf(at, now, locale, t)}` : ""}</>;
    return <li key={key} data-member={key} data-depth={node.depth} className={`group-node${node.depth > 0 ? " is-child" : ""}${line.folded ? " is-folded" : ""}`}
      style={{ "--group-depth": node.depth } as React.CSSProperties}>
      {/* a thin line per level at the left, Reddit's thread: a tap folds that level's chat's branch */}
      {line.ancestors.map((ancestor, level) => <button key={ancestor} type="button" className="group-thread" tabIndex={-1} style={{ "--thread-level": level } as React.CSSProperties}
        aria-label={t("Fold {name}", { name: nameOfKey(ancestor) })} title={t("Fold {name}", { name: nameOfKey(ancestor) })} onClick={() => toggle(ancestor)} />)}
      <p className="group-relation">
        {line.parent && !line.continued ? <button type="button" className="group-fold-toggle" aria-expanded={!line.folded}
          aria-label={line.folded ? t("Unfold {name}", { name: nameOfNode(node) }) : t("Fold {name}", { name: nameOfNode(node) })} onClick={() => toggle(key)}>
          <ChevronRight aria-hidden="true" /><span>{relationLine}</span>
        </button> : relationLine}
      </p>
      <div className={`agent-item host-chat-item${selected ? " is-selected" : ""}${offline || gone ? " is-offline" : ""}${row?.archived ? " is-archived" : ""}`} data-host-session={node.session}>
        <button type="button" className="agent-select agent-row" aria-current={selected ? "true" : undefined} title={[title, row?.cwd].filter(Boolean).join("\n")}
          onClick={() => onOpenChat({ machineId: node.pc, session: node.session })}>
          <AgentRowBody mark="copilot" markKind="Copilot" title={title} name={null} place={pcNames ? machine?.name ?? node.pc : null} context={context} tokens={[]}
            status={row ? hostChatStatus(row) : undefined} cacheRing={mark} cacheWords={mark ? cacheWords(mark, t) : null} />
          {cost && <RowCostCell cost={cost} />}
        </button>
      </div>
      {summary && !line.folded && <p className="group-summary">{summary}</p>}
      {/* a folded branch: one line, its live state still said, so a warm or working chat is never hidden without a sign */}
      {line.folded && <button type="button" className="group-fold" onClick={() => toggle(key)}>
        <span>{t(hiddenCount === 1 ? "+1 chat" : "+{n} chats", { n: hiddenCount })}</span>
        {hasGroupState(hiddenStates) && <><span aria-hidden="true">·</span><GroupStateSummary states={hiddenStates} /></>}
      </button>}
      {line.continued && <button type="button" className="group-continue" onClick={() => setRoots((last) => [...last, key])}>
        <span>{t("Continue this thread")}</span><ChevronRight aria-hidden="true" />
        <span className="group-continue-count">{t(hiddenCount === 1 ? "(1 chat)" : "({n} chats)", { n: hiddenCount })}</span>
        {hasGroupState(hiddenStates) && <GroupStateSummary states={hiddenStates} />}
      </button>}
    </li>;
  };

  return createPortal(
    <div className="modal-scrim new-session-scrim group-page-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; page.current = node; }} className="modal group-page all-agents" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header group-page-head">
          <button type="button" className="icon-button" aria-label={t("Back")} title={t("Back")} onClick={back}><ChevronLeft aria-hidden="true" /></button>
          <div className="group-page-title">
            <h2 className="modal-title" id={`${id}-title`}>{group.name}</h2>
            <span className="group-page-sub">
              <span>{t(count === 1 ? "1 chat" : "{n} chats", { n: count })}</span>
              {hasGroupState(shownStates) && <><span aria-hidden="true">·</span><GroupStateSummary states={shownStates} /></>}
              <span aria-hidden="true">·</span>
              <span>{t("{date} – now", { date: shortDate(first, locale) })}</span>
              {total && <><span aria-hidden="true">·</span><span>{listUsd(total.usd, total.floor)}</span></>}
            </span>
          </div>
          <button type="button" className="icon-button" aria-label={t("More for {title}", { title: group.name })} aria-haspopup="menu" aria-expanded={menu !== null}
            onClick={(event) => setMenu(menu ? null : event.currentTarget)}><Ellipsis aria-hidden="true" /></button>
        </header>
        <div className="modal-body group-page-body">
          {/* the digest card goes here (Task 9): nothing shows in its place yet */}
          <section className="all-agents-group" aria-label={t("Chats")}>
            <h3 className="sidebar-section-label all-agents-age">{t("Chats")}</h3>
            {shown.path.length > 0 && <nav className="group-crumbs" aria-label={t("Thread")}>
              <ol>{shown.path.map((node, index) => {
                const last = index === shown.path.length - 1;
                const target = node.depth === 0 ? null : chatKey(node.pc, node.session);
                return <li key={chatKey(node.pc, node.session)}>
                  {index > 0 && <ChevronRight className="group-crumb-sep" aria-hidden="true" />}
                  {last ? <span className="group-crumb is-current" aria-current="location">{nameOfNode(node)}</span>
                    : <button type="button" className="group-crumb" onClick={() => goTo(target)}>{nameOfNode(node)}</button>}
                </li>;
              })}</ol>
            </nav>}
            <ol className="agent-list group-tree">{lines.map(member)}</ol>
          </section>
          {chips.length > 0 && <section className="all-agents-group group-made" aria-label={t("Made in this group")}>
            <h3 className="sidebar-section-label all-agents-age">{t("Made in this group")}</h3>
            <div className="group-artifacts" role="group" aria-label={t("Artifacts")}>
              {chips.map((each) => {
                const Icon = each.icon;
                return <button key={each.type} type="button" className="session-pill group-artifact-chip" aria-expanded={kind === each.type}
                  onClick={() => { setKind(kind === each.type ? null : each.type); setMore(false); }}>
                  <Icon className="session-pill-icon" aria-hidden="true" />
                  <span className="session-pill-label">{each.label(each.items.length, t)}</span>
                </button>;
              })}
            </div>
            {shownListed.length > 0 && <div className="group-artifact-list">
              <ArtifactList items={shownListed.map((entry) => entry.artifact)} states={referenceStates} onOpen={openArtifact} canOpen={canOpen}
                aside={(artifact) => { const key = creditOf.get(artifact); return key === undefined ? null : <span className="group-artifact-from">{nameOfKey(key)}</span>; }} />
              {listed.length > shownListed.length && <button type="button" className="agent-more group-artifact-more" onClick={() => setMore(true)}>
                <ChevronDown aria-hidden="true" />{t("Show {n} more", { n: listed.length - shownListed.length })}
              </button>}
            </div>}
          </section>}
        </div>
      </div>
      {menu && <RowMenu anchor={menu} title={group.name} onClose={() => setMenu(null)} items={[
        { id: "rename-group", label: t("Rename…"), icon: Pencil, run: () => setAsking("rename") },
        { id: "delete-group", label: t("Delete group…"), icon: Trash2, danger: true, divider: true, run: () => setAsking("delete") },
      ]} />}
      {asking === "rename" && <GroupNameSheet title={t("Rename group")} name={group.name} action={t("Save")} onClose={() => setAsking(null)}
        onSave={async (name) => { await groupsApi.rename(group.id, name); }} />}
      {asking === "delete" && <ConfirmDialog title={t("Delete group?")} body={t("Its chats stay as they are, in no group; a hand-off won't put them back.")} confirmLabel={t("Delete")}
        onClose={() => setAsking(null)} onConfirm={async () => { await groupsApi.remove(group.id); setAsking(null); onClose(); }} />}
    </div>,
    document.body,
  );
}
