/**
 * "All agents on <PC>…": every host chat of a PC, the ones the sidebar does not place too
 * (lib/hostPlacement.ts). A sheet (a bottom sheet on a phone) with a search box, a pill per folder
 * to narrow the list to one, and the chats under VS Code's session-list ages (Today, Yesterday, Last
 * 7 days, Last 30 days, Older: lib/hostChatGroups.ts), each with when it last changed and, under All,
 * its folder; the archived ones last, folded. Picking one opens it, as a look (App.tsx selectHostChat).
 * With `folder` it is "Chats in <folder>…", an agent host workspace's own list: that folder's chats only.
 * With costs tracked (ZAC-260) each Copilot chat the PC's bridge has a log of gets its cost and a
 * split bar (the five parts), a dot while its cache is warm or cooling, and its cold restarts on its
 * second line; each age its subtotal. A sort chip first in the folder pills opens Recent · Cost,
 * highest first (Cost: one flat list), and a summary line under them gives the list's total, its
 * count and scope and its split. A chat without a log shows nothing (owner's option A, 2026-10-29).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, ChevronDown, ChevronRight, Clock, Ellipsis, Search, X } from "lucide-react";

import "./NewSessionDialog.css";
import "./Sidebar.css";
import "./AgentSidebar.css";
import "./AllAgentsSheet.css";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { fetchModelPrices, type ChatPrices } from "../lib/api.ts";
import { listUsd } from "../lib/chatCost.ts";
import { useT } from "../lib/i18n.ts";
import { byAge, byCost, folderKey, folderPills, groupSubtotal, type ChatAge } from "../lib/hostChatGroups.ts";
import { basename, chatAge, fetchHostCosts, hostLine, useMinuteClock, type HostPc } from "../lib/hostChats.ts";
import { cacheState, costSplit, type CostSplit } from "../lib/sessionCost.ts";
import { useSettings } from "../lib/settings.ts";
import { hostChatStatus, samePath } from "../lib/hostPlacement.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { AgentRowBody } from "./AgentSidebar.tsx";
import { hostChatItems, hostChatTitle, useHostChatActions } from "./HostChatActions.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { CostStack } from "./CostParts.tsx";
import { onRowContextMenu } from "./Sidebar.tsx";
import "./SessionSheet.css";

export interface AllAgentsSheetProps {
  machineId: string;
  machineName: string;
  pc: HostPc;
  /** the chat open now, marked in the list */
  selected: string | null;
  /** set: "Chats in <folder>", that folder's chats only (an agent host workspace's menu), with no folder pills */
  folder?: string;
  /** with costs tracked: the order it opens in (the Costs sheet opens a PC's on Cost); Recent by default */
  initialSort?: Sort;
  onOpen(session: string): void;
  onClose(): void;
}

/** The focus is in something over the sheet (a chat's menu, its rename or delete), not on the page under it. */
const outside = (surface: HTMLElement | null): boolean => {
  const active = document.activeElement;
  return active !== null && active !== document.body && !(surface?.contains(active) ?? false);
};

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};

/** VS Code's words for its session-list ages */
const AGE_LABEL: Record<ChatAge, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "Last 30 days",
  older: "Older",
};
/** "all": every folder; else one folder's key (null: chats without one) */
type Pick = "all" | string | null;
type Sort = "recent" | "cost";

/** A chat's cost on its row: its split, and its log for the cache dot and the Cost sort's meta line. */
interface RowCost extends CostSplit { chat: HostChatCost }

/**
 * Each listed chat's cost by session. A log no row runs on (a CLI chat the host does not list) is
 * let go; a partly read log, or any while the bridge's first scan runs, is a floor.
 */
function rowCosts(rows: readonly HostChatRow[], answer: HostCostsAnswer, prices: ChatPrices): Map<string, RowCost> {
  const listed = new Set(rows.map((row) => row.session));
  const costs = new Map<string, RowCost>();
  for (const chat of answer.chats) {
    if (!listed.has(chat.session)) continue;
    const split = costSplit(chat.models, prices.prices ?? {}, prices.fallback);
    costs.set(chat.session, { ...split, floor: split.floor || chat.partial || !answer.complete, chat });
  }
  return costs;
}


export function AllAgentsSheet({ machineId, machineName, pc, selected, folder: only, initialSort = "recent", onOpen, onClose }: AllAgentsSheetProps) {
  const t = useT();
  const id = useId();
  const now = useMinuteClock();
  const { settings } = useSettings();
  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [folder, setFolder] = useState<Pick>("all");
  const [sort, setSort] = useState<Sort>(initialSort);
  // the PC's cost logs and the prices, asked once as the sheet opens while costs are tracked:
  // undefined while asking (or a down host: nothing shown), null for a bridge from before costs
  const track = settings.trackCosts;
  const [answer, setAnswer] = useState<HostCostsAnswer | null | undefined>(undefined);
  const [prices, setPrices] = useState<ChatPrices | null>(null);
  useEffect(() => {
    setAnswer(undefined);
    if (!track) return;
    let live = true;
    void fetchHostCosts(machineId).then((value) => { if (live) setAnswer(value); }, () => { /* a down host: no costs, as before */ });
    void fetchModelPrices().then((value) => { if (live) setPrices(value); });
    return () => { live = false; };
  }, [track, machineId]);
  // each chat's menu: its own actions (HostChatActions.tsx), over the sheet
  const actions = useHostChatActions();
  const [menu, setMenu] = useState<{ session: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null } | null>(null);
  const menuRow = menu ? pc.chats.find((row) => row.session === menu.session) : undefined;
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null);
  // the sheet opens focused on itself, not on the close button, whose ring said "press me" to every
  // tap that opened it, nor on the search field, which would raise a phone's keyboard; Tab still
  // reaches each control, ringed
  const dialog = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: dialog });
  useSheetSwipe(surface, onClose);
  // a chat's menu, or the rename or delete it opened, takes the sheet's Back entry while it is up:
  // its close would otherwise step back off the sheet's entry and close the sheet with it
  usePhoneSheetBack(() => onClose(), menu === null && sortMenu === null && !(actions?.asking ?? false));
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a chat's menu, or the rename or delete it opened over the sheet, takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current) || outside(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const words = query.trim().toLowerCase();
  const matched = useMemo(() => pc.chats.filter((row) => (only === undefined || (row.cwd !== null && samePath(row.cwd) === samePath(only)))
    && (words === "" || row.title.toLowerCase().includes(words) || (row.cwd ?? "").toLowerCase().includes(words))), [pc.chats, words, only]);
  // the pills count what the search keeps; a folder the search empties is let go
  const pills = only === undefined ? folderPills(matched.filter((row) => !row.archived)) : [];
  const shownFolder: Pick = only !== undefined ? folderKey(only) : folder === "all" || pills.some((pill) => pill.cwd === folder) || matched.some((row) => row.archived && folderKey(row.cwd) === folder) ? folder : "all";
  const found = shownFolder === "all" ? matched : matched.filter((row) => folderKey(row.cwd) === shownFolder);
  const current = byAge(found.filter((row) => !row.archived), now);
  // archived chats only while Settings shows them (Agent host); a search then finds none either
  const archived = settings.hostShowArchived ? found.filter((row) => row.archived).sort((a, b) => modified(b) - modified(a)) : [];
  const line = pc.host ? hostLine(pc.host, t) : null;
  // the pill row fades at its end only while it has more to scroll to
  const pillRow = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const measurePills = (): void => {
    const node = pillRow.current;
    setMoreRight(node !== null && node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  };
  useLayoutEffect(measurePills);
  // a price answer with neither table (no gateway, a failed read) prices nothing: no figures then, rather than $0 floors
  const unpriced = prices !== null && prices.prices === null && prices.fallback === null;
  const costs = useMemo(() => (track && answer && prices && !unpriced ? rowCosts(pc.chats, answer, prices) : new Map<string, RowCost>()), [track, answer, prices, unpriced, pc.chats]);
  const costed = costs.size > 0;
  const byCostOn = costed && sort === "cost";
  // a search looks in the archived ones too: what it finds there is shown
  const showArchived = archivedOpen || (words !== "" && archived.length > 0);
  // the total is what the list shows now: the search's and the folder's chats, the archived ones while unfolded
  const shownRows = [...found.filter((row) => !row.archived), ...(showArchived ? archived : [])];
  const total = groupSubtotal(shownRows, costs);
  const shownCount = shownRows.length;

  const item = (row: HostChatRow) => {
    const title = hostChatTitle(row, t);
    // under All the row says its folder; a folder's pill already names it
    const cost = costs.get(row.session);
    // its cold restarts after the folder and age: the list is compared by cost, and the peak size is the open chat's Context tab's
    const restarts = cost?.chat.rewrites ?? 0;
    const context = [row.status === "error" ? t("Error") : null, shownFolder === "all" ? row.cwd ? basename(row.cwd) : t("No folder") : null, chatAge(row, now, t),
      restarts === 1 ? t("1 cold restart") : restarts > 1 ? t("{n} cold restarts", { n: restarts }) : null].filter(Boolean).join(" · ");
    const noPrice = cost && cost.missing.length > 0 ? t("No price for {models}.", { models: cost.missing.join(", ") }) : null;
    const cache = cost ? cacheState(cost.chat.lastCallAt, now, settings.cacheLifetimeMin, row.status === "working") : null;
    // the dot only while resuming is still cheap: a cold cache is every old chat's, and says nothing
    const dot = cache && cache.state !== "cold" ? cache.state : null;
    const localOnly = cost !== undefined && cost.usd === 0 && cost.local.length > 0 && cost.missing.length === 0;
    const menuOpen = menu?.session === row.session;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { session: row.session, anchor, point, previousFocus });
    return <li key={row.session} className={`agent-item host-chat-item${row.session === selected ? " is-selected" : ""}`} data-host-session={row.session}
      onMouseDownCapture={actions ? (event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); } : undefined}
      onContextMenu={actions ? (event) => onRowContextMenu(event, toggleMenu) : undefined}>
      <button type="button" className="agent-select agent-row" aria-current={row.session === selected ? "true" : undefined} title={[title, row.cwd, noPrice].filter(Boolean).join("\n")} onClick={() => onOpen(row.session)}>
        <AgentRowBody mark="copilot" markKind="Copilot" title={title} name={null} context={context} tokens={[]} status={hostChatStatus(row)} />
        {cost && <span className="all-agents-cost">
          <span className="all-agents-usd-line">
            {dot && <span className={`session-dot is-${dot}`} title={t(dot === "warm" ? "Cache warm" : "Cache cooling")}>
              <span className="visually-hidden">{t(dot === "warm" ? "Cache warm" : "Cache cooling")}</span>
            </span>}
            <span className={`all-agents-usd${cost.floor ? " is-floor" : ""}`}>{localOnly ? t("$0 · local") : listUsd(cost.usd, cost.floor)}</span>
          </span>
          {!localOnly && <CostStack split={cost} className="cost-mini all-agents-split" />}
        </span>}
      </button>
      {actions && <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>}
    </li>;
  };

  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; dialog.current = node; }} className="modal new-session-modal all-agents" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{only === undefined ? t("All agents on {pc}", { pc: machineName }) : t("Chats in {folder}", { folder: basename(only) })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body all-agents-body">
          <label className="all-agents-search">
            <Search aria-hidden="true" />
            <input className="input" type="search" value={query} aria-label={t("Search agents")} placeholder={t("Search agents")}
              autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {line && <p className="field-hint" role="status">{line}</p>}
          {/* the sort chip first, then a folder's chats only, as VS Code's sessions view filters by workspace; All is every folder */}
          {(costed || pills.length > 1) && <div ref={pillRow} className={`all-agents-pills${moreRight ? " has-more" : ""}`} onScroll={measurePills}>
            {costed && <button type="button" className={`all-agents-pill all-agents-sort${sortMenu ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={sortMenu !== null}
              aria-label={t("Sort: {order}", { order: t(sort === "recent" ? "Recent" : "Cost") })} onClick={(event) => setSortMenu(sortMenu ? null : event.currentTarget)}>
              <ArrowUpDown aria-hidden="true" /><span>{t(sort === "recent" ? "Recent" : "Cost")}</span><ChevronDown aria-hidden="true" />
            </button>}
            {pills.length > 1 && <div className="all-agents-folders" role="radiogroup" aria-label={t("Folders")}>
              {[{ cwd: "all" as Pick, count: pills.reduce((sum, pill) => sum + pill.count, 0) }, ...pills].map((pill) => {
                const name = pill.cwd === "all" ? t("All") : pill.cwd ? basename(pill.cwd) : t("No folder");
                const on = shownFolder === pill.cwd;
                return <button key={pill.cwd ?? "\0none"} type="button" role="radio" aria-checked={on} className={`all-agents-pill${on ? " is-on" : ""}`}
                  title={pill.cwd !== "all" && pill.cwd ? pill.cwd : undefined} onClick={() => setFolder(pill.cwd)}>
                  <span className="all-agents-pill-name">{name}</span><span className="all-agents-pill-count">{pill.count}</span>
                </button>;
              })}
            </div>}
          </div>}
          {track && answer === null && <p className="field-hint" role="status">{t("Update the bridge on this PC to show costs.")}</p>}
          {track && answer && unpriced && <p className="field-hint" role="status">{t("Prices are unavailable: costs not shown.")}</p>}
          {/* what the list shows now, in both sorts: its total, how many chats of which folder, and what the money went on */}
          {costed && <p className="all-agents-summary">
            <strong className={`all-agents-summary-total${total.floor ? " is-floor" : ""}`}>{listUsd(total.usd, total.floor)}</strong>
            <span className="all-agents-summary-scope">{t(shownCount === 1 ? "1 chat · {scope}" : "{n} chats · {scope}", { n: shownCount, scope: shownFolder === "all" ? t("all folders") : shownFolder ? basename(shownFolder) : t("No folder") })}</span>
            <CostStack split={total} className="all-agents-summary-split" />
          </p>}
          <hr className="all-agents-list-start" />
          {costed && total.missing.length > 0 && <p className="field-hint all-agents-missing">{t("No price for {models}.", { models: total.missing.join(", ") })}</p>}
          {current.length === 0 && archived.length === 0 && <p className="agent-empty" role="status">{t(words === "" ? "No agents yet" : "No agents match")}</p>}
          {byCostOn ? <section className="all-agents-group" aria-label={t("Cost")}>
            <ul className="agent-list">{byCost(current.flatMap((group) => group.chats), costs).map(item)}</ul>
          </section> : current.map((group) => {
            const subtotal = groupSubtotal(group.chats, costs);
            return <section key={group.age} className="all-agents-group" aria-label={t(AGE_LABEL[group.age])}>
              {costed ? <h3 className="sidebar-section-label all-agents-age is-costed">
                <span>{t(AGE_LABEL[group.age])}</span>
                {group.chats.some((row) => costs.has(row.session)) && <span className="all-agents-subtotal">{listUsd(subtotal.usd, subtotal.floor)}</span>}
              </h3> : <h3 className="sidebar-section-label all-agents-age">{t(AGE_LABEL[group.age])}</h3>}
              <ul className="agent-list">{group.chats.map(item)}</ul>
            </section>;
          })}
          {archived.length > 0 && <section className="all-agents-group" aria-label={t("Archived")}>
            <button type="button" className="sidebar-section-label all-agents-archived" aria-expanded={showArchived} onClick={(event) => {
              const opening = !showArchived;
              setArchivedOpen(opening);
              // Archived sits last, under every folder: what it opens on lands below the fold, so it is brought up
              const section = event.currentTarget.parentElement;
              if (opening && section) requestAnimationFrame(() => section.scrollIntoView({ block: "start", behavior: "smooth" }));
            }}>
              {showArchived ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              <span>{t("Archived")}</span>
              <span className="agent-section-count">{archived.length}</span>
            </button>
            {showArchived && <ul className="agent-list">{archived.map(item)}</ul>}
          </section>}
        </div>
      </div>
      {sortMenu && <RowMenu anchor={sortMenu} align="start" popover title={t("Sort by")} onClose={() => setSortMenu(null)} items={[
        { id: "recent", label: t("Recent"), icon: Clock, checked: sort === "recent", run: () => setSort("recent") },
        { id: "cost", label: t("Cost, highest first"), icon: ArrowUpDown, checked: sort === "cost", run: () => setSort("cost") },
      ]} />}
      {menu && menuRow && actions && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={hostChatTitle(menuRow, t)} subtitle={menuRow.cwd ?? undefined}
        items={hostChatItems(actions, { machineId, chat: menuRow }, t)} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  );
}
