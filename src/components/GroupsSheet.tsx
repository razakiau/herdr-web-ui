/**
 * Chat groups (ZAC-265), the Groups view (owner's option B): every group across the PCs, in All
 * agents' frame (AllAgentsSheet.tsx): a pill per folder (All, then each group's repo), Recent | Cost
 * while costs are tracked, then a card per group with its name, how many of its chats work now, the
 * digest's first lines (or "No digest yet"), what it holds and cost, and a rail of dots, one per chat
 * in hand-off order (archived ones hollow, a working one in the working colour). "+" starts an empty
 * group; a card opens the group's page (GroupPage.tsx). Opened from a PC's menu, next to "All agents
 * on <PC>…" (MachineSidebar.tsx), only with Settings → Chat groups on.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Layers, Plus, X } from "lucide-react";

import "./NewSessionDialog.css";
import "./AllAgentsSheet.css";
import "./GroupsSheet.css";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import { listUsd } from "../lib/chatCost.ts";
import { chainOrder, chatKey, costOf, groupsApi, type ChainStep } from "../lib/groups.ts";
import { basename, errorText, type HostPc } from "../lib/hostChats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { CostSplit } from "../lib/sessionCost.ts";

/** Every PC's chats by chatKey: the rows a group's members are drawn from. */
export function rowsByKey(hostChats: ReadonlyMap<string, HostPc>): Map<string, HostChatRow> {
  const rows = new Map<string, HostChatRow>();
  for (const [pc, list] of hostChats) for (const row of list.chats) rows.set(chatKey(pc, row.session), row);
  return rows;
}

const modified = (row: HostChatRow | undefined): number => {
  const at = row ? Date.parse(row.modified_at) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

/** The folder a group is about: its chats' repo (or folder) most of them share, the newest chat's on a tie; null when no chat has one. */
export function groupFolder(group: ChatGroup, rows: ReadonlyMap<string, HostChatRow>): string | null {
  const counts = new Map<string, { count: number; newest: number }>();
  for (const member of group.members) {
    const row = rows.get(chatKey(member.pc, member.session));
    const folder = row?.repo ?? row?.cwd;
    if (!folder) continue;
    const name = basename(folder);
    const entry = counts.get(name) ?? { count: 0, newest: 0 };
    counts.set(name, { count: entry.count + 1, newest: Math.max(entry.newest, modified(row)) });
  }
  return [...counts].sort((a, b) => b[1].count - a[1].count || b[1].newest - a[1].newest)[0]?.[0] ?? null;
}

/** When the group last moved: its newest chat's change, else its own. */
export const groupActive = (group: ChatGroup, rows: ReadonlyMap<string, HostChatRow>): number =>
  Math.max(Date.parse(group.updatedAt) || 0, ...group.members.map((member) => modified(rows.get(chatKey(member.pc, member.session)))));

/** A short date in the page's language: "Oct 29". */
export const shortDate = (at: number, locale: string): string => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);

export interface GroupsSheetProps {
  answer: GroupsAnswer | null;
  failed: boolean;
  machines: readonly Machine[];
  hostChats: ReadonlyMap<string, HostPc>;
  /** each chat's cost by chatKey (lib/groups.ts chatCosts); empty when costs are not tracked */
  costs: ReadonlyMap<string, CostSplit>;
  onOpenGroup(id: number): void;
  onClose(): void;
}

type Sort = "recent" | "cost";

export function GroupsSheet({ answer, failed, machines, hostChats, costs, onOpenGroup, onClose }: GroupsSheetProps) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [folder, setFolder] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [naming, setNaming] = useState(false);
  const dialog = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: dialog });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => onClose(), !naming);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || naming || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  const groups = answer?.groups ?? [];
  const folders = useMemo(() => new Map(groups.map((group) => [group.id, groupFolder(group, rows)])), [groups, rows]);
  const pills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of folders.values()) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [folders]);
  const shownFolder = folder === "all" || pills.some(([name]) => name === folder) ? folder : "all";
  const totals = useMemo(() => new Map(groups.map((group) => [group.id, costOf(group.members.map((member) => chatKey(member.pc, member.session)), costs)])), [groups, costs]);
  const costed = [...totals.values()].some((total) => total !== null);
  const shown = groups.filter((group) => shownFolder === "all" || folders.get(group.id) === shownFolder)
    .sort(costed && sort === "cost"
      ? (a, b) => (totals.get(b.id)?.usd ?? -1) - (totals.get(a.id)?.usd ?? -1)
      : (a, b) => groupActive(b, rows) - groupActive(a, rows));
  const pcName = (pc: string): string => machines.find((machine) => machine.id === pc)?.name ?? pc;

  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; dialog.current = node; }} className="modal new-session-modal all-agents groups-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <div className="groups-sheet-title">
            <h2 className="modal-title" id={`${id}-title`}>{t("Groups")}</h2>
            <span className="groups-sheet-scope">{t("all PCs")}</span>
          </div>
          <button type="button" className="icon-button" aria-label={t("New group")} title={t("New group")} onClick={() => setNaming(true)}><Plus aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body all-agents-body">
          {pills.length > 1 && <div className="all-agents-pills" role="radiogroup" aria-label={t("Folders")}>
            {[["all", groups.length] as const, ...pills].map(([name, count]) => {
              const on = shownFolder === name;
              return <button key={name} type="button" role="radio" aria-checked={on} className={`all-agents-pill${on ? " is-on" : ""}`} onClick={() => setFolder(name)}>
                <span className="all-agents-pill-name">{name === "all" ? t("All") : name}</span><span className="all-agents-pill-count">{count}</span>
              </button>;
            })}
          </div>}
          {costed && <div className="segmented groups-sort" role="group" aria-label={t("Sort by")}>
            <button type="button" aria-pressed={sort === "recent"} onClick={() => setSort("recent")}>{t("Recent")}</button>
            <button type="button" aria-pressed={sort === "cost"} onClick={() => setSort("cost")}>{t("Cost")}</button>
          </div>}
          {answer === null && <p className="agent-empty" role="status">{t(failed ? "Couldn't read the groups." : "Loading groups…")}</p>}
          {answer !== null && groups.length === 0 && <p className="agent-empty" role="status">{t("No groups yet. A chat that hands off to another starts one, or tap + to make one.")}</p>}
          <ul className="groups-list">
            {shown.map((group) => <GroupCard key={group.id} group={group} answer={answer!} rows={rows} total={totals.get(group.id) ?? null} pcName={pcName} locale={locale} onOpen={() => onOpenGroup(group.id)} />)}
          </ul>
        </div>
      </div>
      {naming && <GroupNameSheet title={t("New group")} name="" action={t("Create")} onClose={() => setNaming(false)}
        onSave={async (name) => { const made = await groupsApi.create(name); onOpenGroup(made.id); }} />}
    </div>,
    document.body,
  );
}

/** The dots of a group's rail: at most this many, then "… N more". */
const RAIL_DOTS = 8;

function GroupCard({ group, answer, rows, total, pcName, locale, onOpen }: {
  group: ChatGroup; answer: GroupsAnswer; rows: ReadonlyMap<string, HostChatRow>; total: CostSplit | null; pcName(pc: string): string; locale: string; onOpen(): void;
}) {
  const t = useT();
  const order = chainOrder(group, answer.links, rows);
  const rowOf = (step: ChainStep) => rows.get(chatKey(step.pc, step.session));
  const working = order.filter((step) => rowOf(step)?.status === "working").length;
  const digest = answer.digests.find((each) => each.groupId === group.id);
  const count = group.members.length;
  const firstAt = Math.min(Date.parse(group.createdAt) || Date.now(), ...group.members.map((member) => modified(rows.get(chatKey(member.pc, member.session))) || Number.POSITIVE_INFINITY));
  const pcs = [...new Set(group.members.map((member) => pcName(member.pc)))].join(", ");
  const chats = t(count === 1 ? "1 chat" : "{n} chats", { n: count });
  const meta = [chats, pcs, total ? listUsd(total.usd, total.floor) : null, digest ? t("digest {date}", { date: shortDate(Date.parse(digest.writtenAt), locale) }) : null].filter(Boolean).join(" · ");
  const linked = order.filter((step) => step.join?.kind !== "manual");
  const added = order.length - linked.length;
  const dots = linked.length > RAIL_DOTS ? linked.slice(0, RAIL_DOTS - 1) : linked;
  return <li className="groups-card-item">
    <button type="button" className="groups-card" onClick={onOpen}>
      <span className="groups-card-top">
        <Layers className="groups-card-icon" aria-hidden="true" />
        <strong className="groups-card-name">{group.name}</strong>
        {working > 0 && <span className="badge badge-working">{t(working === 1 ? "1 working" : "{n} working", { n: working })}</span>}
      </span>
      {digest
        ? <span className="groups-card-sum">{digest.direction}</span>
        : <span className="groups-card-sum is-dim">{count === 0 ? t("No chats yet.") : t("No digest yet. {chats} since {date}.", { chats, date: shortDate(firstAt, locale) })}</span>}
      <span className="groups-card-meta">{meta}</span>
      {order.length > 0 && <span className="group-rail" aria-hidden="true">
        {dots.map((step, index) => {
          const row = rowOf(step);
          return <span key={chatKey(step.pc, step.session)} className="group-rail-step">
            {index > 0 && <em />}
            <i className={row?.status === "working" ? "is-working" : row?.archived ? "is-archived" : ""} />
          </span>;
        })}
        {linked.length > dots.length && <span className="group-rail-more">{t("… {n} more", { n: linked.length - dots.length })}</span>}
        {added > 0 && <span className="group-rail-more">{t("+{n} added", { n: added })}</span>}
      </span>}
    </button>
  </li>;
}

/** "New group" and "Rename group": one field, the name in it; an empty name is not sent. A refusal is said in the sheet. */
export function GroupNameSheet({ title, name, action, onSave, onClose }: { title: string; name: string; action: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLFormElement>(true, { initialFocus: field });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => onClose());
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const save = (): void => {
    const next = value.trim();
    if (next === "") { setError(t("A group needs a name.")); return; }
    if (next === name.trim()) { onClose(); return; }
    setBusy(true);
    onSave(next).then(onClose, (cause: unknown) => { setBusy(false); setError(errorText(cause)); });
  };
  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form ref={surface} className="modal new-session-modal host-chat-rename" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        onSubmit={(event) => { event.preventDefault(); save(); }}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{t("Group name")}</span>
            <input ref={field} className="input" value={value} maxLength={200} autoComplete="off" spellCheck={false} aria-invalid={error !== null || undefined}
              onChange={(event) => { setValue(event.target.value); setError(null); }} />
          </label>
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{action}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
