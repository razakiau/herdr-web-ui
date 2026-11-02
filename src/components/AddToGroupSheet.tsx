/**
 * Chat groups (ZAC-265), "Add to group" for one chat, a sheet from the chat's ⋯ (owner, round 8: ten
 * groups and more to come). A search over the groups' names and their chats' titles (focused beside
 * a mouse only, so a phone's keyboard does not cover the list), "New group…" under it, then
 * Suggested (at most three, lib/groupSuggest.ts: a ticket key the chat shares, its folder, then the
 * most recent, each saying why) and All groups by recent activity, each one line of name, chats, and
 * its age or how its chats are doing. The one it is in is ticked. "Split here" (only in a group)
 * moves this chat and the ones after it to a new group; Add puts it in the picked group, out of the
 * one it was in. A refusal is said in the sheet, which stays.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Split } from "lucide-react";

import "./NewSessionDialog.css";
import "./AllAgentsSheet.css";
import "./AddToGroupSheet.css";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import type { CostsFeed } from "../lib/rowCache.ts";
import { chatKey, groupOf, groupOnPc, groupsApi, type ChatRef } from "../lib/groups.ts";
import { groupMatches, suggestGroups, type GroupFacts, type SuggestReason } from "../lib/groupSuggest.ts";
import { ageWords, basename, errorText, type HostPc } from "../lib/hostChats.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { GroupNameSheet, groupActive, groupFolder, rowsByKey } from "./GroupsSheet.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { GroupPcFilter, groupPcs } from "./GroupPcFilter.tsx";
import { GroupStateSummary, useMemberStates } from "./GroupState.tsx";
import { SearchField } from "./SearchField.tsx";

/** How a group's chats are doing, as its card and page say it ("1 working · 2 warm"); nothing when all are idle and cold. */
function GroupRowState({ group, rows, feed }: { group: ChatGroup; rows: ReadonlyMap<string, HostChatRow>; feed: CostsFeed | null }) {
  const { states } = useMemberStates(group, rows, feed);
  return <GroupStateSummary states={[...states.values()]} className="add-to-group-state" />;
}

/** Why a group is suggested, small and dim under its name. */
function reasonWords(reason: SuggestReason, now: number, t: Translate): string {
  switch (reason.kind) {
    case "ticket": return t("same ticket {key}", { key: reason.key });
    case "folder": return t("same folder");
    case "recent": return now - reason.at < 2 * 60_000 ? t("active now") : t("active {age}", { age: ageWords(reason.at, now, t) });
  }
}

export function AddToGroupSheet({ chat, mergeFrom = null, answer, hostChats, machines = [], feed = null, onMerged, onClose }: {
  /** the chat to place; for a merge, the source group's first chat (only its title and folder steer Suggested) */
  chat: ChatRef;
  /**
   * "Merge into…" (round 10, the group page's ⋯): the same picker for a target group, the source left
   * out, no New group or Split; the primary asks first, then every chat of the source moves
   */
  mergeFrom?: ChatGroup | null;
  /** after a merge, the group it went into */
  onMerged?(into: number): void;
  answer: GroupsAnswer | null;
  hostChats: ReadonlyMap<string, HostPc>;
  /** the PCs, for the PC filter's names */
  machines?: readonly Machine[];
  /** the page's costs feed (lib/rowCache.ts), for each group's live state as its card says it; null while costs are not tracked */
  feed?: CostsFeed | null;
  onClose(): void;
}) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // beside a mouse the search takes the caret; a phone keeps its keyboard down until the field is tapped
  const coarse = useMediaQuery("(pointer: coarse)");
  const current = mergeFrom ?? groupOf(answer, chat.pc, chat.session);
  const merging = mergeFrom !== null;
  const [picked, setPicked] = useState<number | null>(merging ? null : current?.id ?? null);
  const [naming, setNaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: coarse ? dialog : search });
  useSheetSwipe(surface, onClose);
  // the PC pill's menu, while up, takes the sheet's Back entry and its Escape (as All agents' sort does)
  const [pcMenu, setPcMenu] = useState(false);
  usePhoneSheetBack(() => onClose(), !naming && !confirming && !pcMenu);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || naming || confirming || pcMenu || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const rows = useMemo(() => rowsByKey(hostChats), [hostChats]);
  const own = rows.get(chatKey(chat.pc, chat.session));
  const ownFolder = own?.repo ?? own?.cwd;
  const here = ownFolder ? basename(ownFolder) : null;
  // the PC filter (round 10): the groups with a chat on the PC picked, Suggested among them too
  const [onPc, setOnPc] = useState<string | null>(null);
  const pcs = useMemo(() => groupPcs(answer?.groups ?? []), [answer]);
  // the search row stays while a PC filter empties the lists (there are groups to search)
  const anyGroup = (answer?.groups ?? []).some((group) => group.id !== mergeFrom?.id);
  const pcName = (pc: string): string => machines.find((machine) => machine.id === pc)?.name ?? pc;
  const groups: GroupFacts[] = useMemo(() => (answer?.groups ?? []).filter((group) => groupOnPc(group, onPc) && group.id !== mergeFrom?.id)
    .map((group) => ({ group, folder: groupFolder(group, rows), active: groupActive(group, rows) }))
    .sort((a, b) => b.active - a.active), [answer, rows, onPc, mergeFrom]);
  const searching = query.trim() !== "";
  // under a search: the groups that answer it, by activity; else Suggested, then every group but those
  // a merge is steered by the source group: its name and its chats' titles (their ticket keys), its folder
  const steer = useMemo(() => mergeFrom
    ? { title: [mergeFrom.name, ...mergeFrom.members.map((member) => rows.get(chatKey(member.pc, member.session))?.title ?? "")].join("\n"), folder: groupFolder(mergeFrom, rows) }
    : { title: own?.title ?? "", folder: here }, [mergeFrom, rows, own, here]);
  const suggested = useMemo(() => searching ? [] : suggestGroups(steer, groups, rows, current?.id ?? null), [searching, steer, groups, rows, current]);
  const suggestedIds = new Set(suggested.map((each) => each.facts.group.id));
  const listed = searching ? groups.filter((each) => groupMatches(each.group, rows, query)) : groups.filter((each) => !suggestedIds.has(each.group.id));
  const now = Date.now();
  const run = async (deed: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await deed();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  const add = (): void => {
    if (merging) { if (picked !== null) setConfirming(true); return; }
    if (picked === null || picked === current?.id) { onClose(); return; }
    void run(() => groupsApi.add(picked, chat));
  };

  // a group's row: the pick's circle, its name, then one dim line: why it is suggested, or its chats, folder and age; how its chats are doing at the end
  const row = ({ group, folder, active }: GroupFacts, why: string | null) => {
    const on = picked === group.id;
    const count = group.members.length;
    const when = now - active < 15 * 60_000 ? t("active now") : ageWords(active, now, t);
    const sub = [t(count === 1 ? "1 chat" : "{n} chats", { n: count }), why ?? folder, why === null ? when : null].filter(Boolean).join(" · ");
    return <button key={group.id} type="button" role="radio" aria-checked={on} className={`add-to-group-row${on ? " is-on" : ""}`} onClick={() => setPicked(group.id)}>
      <span className="add-to-group-check" aria-hidden="true">{on && <Check />}</span>
      <span className="add-to-group-text"><span className="add-to-group-name">{group.name}</span><small>{sub}</small></span>
      <GroupRowState group={group} rows={rows} feed={feed} />
    </button>;
  };

  return createPortal(<>
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; dialog.current = node; }} className="modal new-session-modal add-to-group" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{merging ? t("Merge into…") : t("Add to group")}</h2></header>
        <div className="modal-body add-to-group-body">
          <p className="add-to-group-hint" id={`${id}-hint`}>{mergeFrom
            ? t("Every chat of {name} moves to the group you pick, and {name} goes.", { name: mergeFrom.name })
            : current
            ? t("This chat is in {name}. Pick another group to move it, or split the group here.", { name: current.name })
            : t("This chat isn't in a group. Pick one, or start a new group with it.")}</p>
          {/* one row: the PC filter, compact, then the search taking the rest (round 11: the same in a merge and in the sidebar) */}
          {anyGroup && <div className="add-to-group-search-line">
            <GroupPcFilter pcs={pcs} value={onPc} pcName={pcName} onChange={setOnPc} onOpenChange={setPcMenu} />
            <SearchField className="add-to-group-search" inputRef={search} value={query} onValue={setQuery} label={t("Search groups and their chats")} placeholder={t("Search groups")}
              autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" />
          </div>}
          {/* always in reach: a new group under the search, above any list */}
          {!merging && <button type="button" className="add-to-group-row add-to-group-new" disabled={busy} onClick={() => setNaming(true)}>
            <Plus className="add-to-group-icon is-accent" aria-hidden="true" />
            <span className="add-to-group-text">{t("New group…")}</span>
          </button>}
          {onPc !== null && groups.length === 0 && <p className="add-to-group-none" role="status">{t("No group has a chat on {pc}.", { pc: pcName(onPc) })}</p>}
          {groups.length > 0 && <div className="add-to-group-list" role="radiogroup" aria-label={t("Groups")}>
            {suggested.length > 0 && <h3 className="sidebar-section-label add-to-group-label" aria-hidden="true">{t("Suggested")}</h3>}
            {suggested.map(({ facts, reason }) => row(facts, reasonWords(reason, now, t)))}
            {!searching && listed.length > 0 && <h3 className="sidebar-section-label add-to-group-label" aria-hidden="true">{suggested.length > 0 ? t("All groups") : t("Groups")}</h3>}
            {listed.map((facts) => row(facts, null))}
            {searching && listed.length === 0 && <p className="add-to-group-none" role="status">{t("No group has “{query}” in its name or its chats.", { query: query.trim() })}</p>}
          </div>}
          {current && !merging && <hr className="add-to-group-divider" />}
          {current && !merging && <button type="button" className="add-to-group-row" disabled={busy} onClick={() => void run(() => groupsApi.split(chat))}>
            <Split className="add-to-group-icon" aria-hidden="true" />
            <span className="add-to-group-text">{t("Split here")}<small>{t("this chat and the ones after it start a new group")}</small></span>
          </button>}
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer add-to-group-footer">
          <button type="button" className="btn btn-primary add-to-group-go" disabled={busy || picked === null} onClick={add}>
            {merging ? t("Merge…") : picked !== null && current !== null && picked !== current.id ? t("Move") : t("Add")}
          </button>
        </footer>
      </div>
    </div>
    {confirming && mergeFrom && picked !== null && <ConfirmDialog title={t("Merge {from} into {into}?", { from: mergeFrom.name, into: answer?.groups.find((each) => each.id === picked)?.name ?? "" })}
      body={t("Its chats move for good: a hand-off won't take them back. Its digest is dropped.")} confirmLabel={t("Merge")}
      onClose={() => setConfirming(false)} onConfirm={async () => { await groupsApi.merge(mergeFrom.id, picked); setConfirming(false); onClose(); onMerged?.(picked); }} />}
    {naming && <GroupNameSheet title={t("New group")} name="" action={t("Create")} onClose={() => setNaming(false)}
      onSave={async (name) => { await groupsApi.create(name, chat); onClose(); }} />}
  </>, document.body);
}
