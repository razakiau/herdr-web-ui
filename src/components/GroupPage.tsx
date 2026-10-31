/**
 * Chat groups (ZAC-265), one group's page (owner's option E): one scrolling page. Its header names
 * the group, "N chats · <first date> – now · ~$cost" and a ⋯ (Rename, Delete). The digest card's
 * place comes next (Task 9 fills it; nothing shows there yet). Then the artifacts of every chat in
 * chips by kind ("2 pull requests · 3 files"), each opening its list labelled with the chats it
 * came from, the same PR made in two chats once (lib/groups.ts dedupArtifacts); they are read from
 * each chat's own read when the page opens, a PC that is offline not asked. Then the timeline: a
 * card per chat in hand-off order (lib/groups.ts chainOrder), its title, an archived icon or a
 * working badge, its summary, "PC · date · ~$cost", and between cards the join ("handed off ·
 * resume", "262 also handed off", "added by you"). A tap opens the chat, an archived one too (it
 * goes on through ZAC-266's hand-off). A chat whose PC is offline says "PC offline", one its PC no
 * longer lists "gone": neither is hidden.
 */
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Archive, ArrowRight, ChevronLeft, Ellipsis, GitBranch, GitCommitHorizontal, GitPullRequest, Globe, CircleDot, Link, Package, Pencil, Plus, Split, Trash2, type LucideProps } from "lucide-react";

import "./NewSessionDialog.css";
import "./GroupsSheet.css";
import "./GroupPage.css";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostArtifact, HostArtifactType, HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import { listUsd } from "../lib/chatCost.ts";
import { chainOrder, chatKey, costOf, dedupArtifacts, groupsApi, shortChatName, type ChainStep } from "../lib/groups.ts";
import { fetchHostChat, type HostPc } from "../lib/hostChats.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { daysBack } from "../lib/hostChatGroups.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { CostSplit } from "../lib/sessionCost.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { GroupNameSheet, rowsByKey, shortDate } from "./GroupsSheet.tsx";
import { RowMenu } from "./RowMenu.tsx";

export interface GroupPageProps {
  group: ChatGroup;
  answer: GroupsAnswer;
  machines: readonly Machine[];
  hostChats: ReadonlyMap<string, HostPc>;
  /** each chat's cost by chatKey (lib/groups.ts chatCosts) */
  costs?: ReadonlyMap<string, CostSplit>;
  onOpenChat(target: { machineId: string; session: string }): void;
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

/** A chat's day as the timeline says it: "today", "Oct 29". */
const dayOf = (at: number, now: number, locale: string, t: Translate): string => daysBack(at, now) <= 0 ? t("today") : shortDate(at, locale);

export function GroupPage({ group, answer, machines, hostChats, costs = NO_COSTS, onOpenChat, onClose }: GroupPageProps) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [asking, setAsking] = useState<"rename" | "delete" | null>(null);
  const [kind, setKind] = useState<HostArtifactType | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: page });
  usePhoneSheetBack(() => onClose(), menu === null && asking === null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || menu !== null || asking !== null || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  const order = useMemo(() => chainOrder(group, answer.links, rows), [group, answer.links, rows]);
  const artifacts = useMemberArtifacts(group, machines);
  const gathered = useMemo(() => dedupArtifacts(artifacts), [artifacts]);
  const now = Date.now();
  const machineOf = (pc: string): Machine | undefined => machines.find((machine) => machine.id === pc);
  const rowOf = (step: { pc: string; session: string }): HostChatRow | undefined => rows.get(chatKey(step.pc, step.session));
  const titleOf = (step: { pc: string; session: string }): string => rowOf(step)?.title.trim() || t("Copilot chat");
  const keys = group.members.map((member) => chatKey(member.pc, member.session));
  const total = costOf(keys, costs);
  const times = group.members.map((member) => Date.parse(rows.get(chatKey(member.pc, member.session))?.modified_at ?? "")).filter(Number.isFinite);
  const first = Math.min(Date.parse(group.createdAt) || now, ...times);
  const count = group.members.length;
  const sub = [t(count === 1 ? "1 chat" : "{n} chats", { n: count }), t("{date} – now", { date: shortDate(first, locale) }), total ? listUsd(total.usd, total.floor) : null].filter(Boolean).join(" · ");
  const summaries = new Map(answer.summaries.map((summary) => [chatKey(summary.pc, summary.session), summary.text]));
  const open = (step: ChainStep): void => onOpenChat({ machineId: step.pc, session: step.session });
  const chips = KINDS.map((each) => ({ ...each, items: gathered.filter((entry) => entry.artifact.type === each.type) })).filter((each) => each.items.length > 0);
  const listed = kind === null ? [] : chips.find((each) => each.type === kind)?.items ?? [];

  const join = (step: ChainStep): string | null => {
    if (step.join === null) return null;
    if (step.join.kind === "manual") return t("added by you");
    const how = step.join.kind === "fork" ? t("forked") : t("handed off · {how}", { how: step.join.kind });
    if (step.forkNote === undefined) return how;
    return t("{name} also handed off · {how}", { name: shortChatName(titleOf({ pc: step.pc, session: step.forkNote })), how: step.join.kind });
  };
  const JoinIcon = (step: ChainStep) => step.join?.kind === "manual" ? Plus : step.forkNote !== undefined ? Split : step.join?.kind === "fork" ? GitBranch : ArrowRight;

  return createPortal(
    <div className="modal-scrim new-session-scrim group-page-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; page.current = node; }} className="modal group-page" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header group-page-head">
          <button type="button" className="icon-button" aria-label={t("Back")} title={t("Back")} onClick={onClose}><ChevronLeft aria-hidden="true" /></button>
          <div className="group-page-title">
            <h2 className="modal-title" id={`${id}-title`}>{group.name}</h2>
            <span className="group-page-sub">{sub}</span>
          </div>
          <button type="button" className="icon-button" aria-label={t("More for {title}", { title: group.name })} aria-haspopup="menu" aria-expanded={menu !== null}
            onClick={(event) => setMenu(menu ? null : event.currentTarget)}><Ellipsis aria-hidden="true" /></button>
        </header>
        <div className="modal-body group-page-body">
          {/* the digest card goes here (Task 9): nothing shows in its place yet */}
          {chips.length > 0 && <div className="group-artifacts" role="group" aria-label={t("Artifacts")}>
            {chips.map((each) => {
              const Icon = each.icon;
              return <button key={each.type} type="button" className="session-pill group-artifact-chip" aria-expanded={kind === each.type} onClick={() => setKind(kind === each.type ? null : each.type)}>
                <Icon className="session-pill-icon" aria-hidden="true" />
                <span className="session-pill-label">{each.label(each.items.length, t)}</span>
              </button>;
            })}
          </div>}
          {listed.length > 0 && <ul className="group-artifact-list">
            {listed.map(({ artifact, from }) => {
              const link = artifact.link ?? artifact.uri;
              const web = link !== undefined && /^https?:\/\//i.test(link);
              const names = from.map((key) => { const at = key.indexOf(" "); return shortChatName(titleOf({ pc: key.slice(0, at), session: key.slice(at + 1) })); }).join(", ");
              return <li key={link ?? artifact.commitHash ?? artifact.id}>
                {web ? <a className="group-artifact" href={link} target="_blank" rel="noopener noreferrer"><span className="group-artifact-label">{artifact.label}</span><span className="group-artifact-from">{names}</span></a>
                  : <span className="group-artifact"><span className="group-artifact-label">{artifact.label}</span><span className="group-artifact-from">{names}</span></span>}
              </li>;
            })}
          </ul>}
          <ol className="group-timeline">
            {order.map((step, index) => {
              const key = chatKey(step.pc, step.session);
              const row = rowOf(step);
              const machine = machineOf(step.pc);
              const offline = machine?.state !== "connected";
              const pc = hostChats.get(step.pc);
              const gone = !offline && row === undefined && pc !== undefined && pc.stale !== true;
              const cost = costs.get(key);
              const at = row ? Date.parse(row.modified_at) : Number.NaN;
              const meta = [machine?.name ?? step.pc, offline ? t("PC offline") : gone ? t("gone") : Number.isFinite(at) ? dayOf(at, now, locale, t) : null, cost ? listUsd(cost.usd, cost.floor) : null].filter(Boolean).join(" · ");
              const words = join(step);
              const Icon = JoinIcon(step);
              const working = row?.status === "working";
              return <li key={key} data-member={key} className={`group-member${offline || gone ? " is-away" : ""}`}>
                {words !== null && index > 0 && <p className="group-join"><Icon aria-hidden="true" />{words}</p>}
                <div className="group-member-row">
                  <span className="group-member-rail" aria-hidden="true">
                    <i className={working ? "is-working" : row?.archived ? "is-archived" : ""} />
                    {index < order.length - 1 && <em />}
                  </span>
                  <button type="button" className="group-member-card" onClick={() => open(step)}>
                    <span className="group-member-head">
                      <strong className="group-member-title">{titleOf(step)}</strong>
                      {row?.archived && <Archive className="group-member-archived" aria-label={t("Archived")} />}
                      {working && <span className="badge badge-working">{t("working")}</span>}
                    </span>
                    <span className={`group-member-sum${summaries.has(key) ? "" : " is-dim"}`}>{summaries.get(key) ?? t("Not summarised yet.")}</span>
                    <span className="group-member-meta">{meta}</span>
                  </button>
                </div>
              </li>;
            })}
          </ol>
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
