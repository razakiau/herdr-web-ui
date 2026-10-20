/**
 * "All agents on <PC>…": every host chat of a PC, the ones the sidebar does not place too
 * (lib/hostPlacement.ts). A sheet (a bottom sheet on a phone) with a search box, a pill per folder
 * to narrow the list to one, and the chats under VS Code's session-list ages (Today, Yesterday, Last
 * 7 days, Last 30 days, Older: lib/hostChatGroups.ts), each with when it last changed and, under All,
 * its folder; the archived ones last, folded. Picking one opens it, as a tab of its workspace or its folder row.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Ellipsis, Search, X } from "lucide-react";

import "./NewSessionDialog.css";
import "./Sidebar.css";
import "./AgentSidebar.css";
import "./AllAgentsSheet.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { byAge, folderKey, folderPills, type ChatAge } from "../lib/hostChatGroups.ts";
import { basename, chatAge, hostLine, useMinuteClock, type HostPc } from "../lib/hostChats.ts";
import { hostChatStatus } from "../lib/hostPlacement.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { AgentRowBody } from "./AgentSidebar.tsx";
import { hostChatItems, hostChatTitle, useHostChatActions } from "./HostChatActions.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { onRowContextMenu } from "./Sidebar.tsx";

export interface AllAgentsSheetProps {
  machineId: string;
  machineName: string;
  pc: HostPc;
  /** the chat open now, marked in the list */
  selected: string | null;
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

export function AllAgentsSheet({ machineId, machineName, pc, selected, onOpen, onClose }: AllAgentsSheetProps) {
  const t = useT();
  const id = useId();
  const now = useMinuteClock();
  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [folder, setFolder] = useState<Pick>("all");
  // each chat's menu: its own actions (HostChatActions.tsx), over the sheet
  const actions = useHostChatActions();
  const [menu, setMenu] = useState<{ session: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null } | null>(null);
  const menuRow = menu ? pc.chats.find((row) => row.session === menu.session) : undefined;
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  // a chat's menu, or the rename or delete it opened, takes the sheet's Back entry while it is up:
  // its close would otherwise step back off the sheet's entry and close the sheet with it
  usePhoneSheetBack(() => onClose(), menu === null && !(actions?.asking ?? false));
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
  const matched = useMemo(() => pc.chats.filter((row) => words === "" || row.title.toLowerCase().includes(words) || (row.cwd ?? "").toLowerCase().includes(words)), [pc.chats, words]);
  // the pills count what the search keeps; a folder the search empties is let go
  const pills = folderPills(matched.filter((row) => !row.archived));
  const shownFolder: Pick = folder === "all" || pills.some((pill) => pill.cwd === folder) || matched.some((row) => row.archived && folderKey(row.cwd) === folder) ? folder : "all";
  const found = shownFolder === "all" ? matched : matched.filter((row) => folderKey(row.cwd) === shownFolder);
  const current = byAge(found.filter((row) => !row.archived), now);
  const archived = found.filter((row) => row.archived).sort((a, b) => modified(b) - modified(a));
  const line = pc.host ? hostLine(pc.host, t) : null;
  // a search looks in the archived ones too: what it finds there is shown
  const showArchived = archivedOpen || (words !== "" && archived.length > 0);

  const item = (row: HostChatRow) => {
    const title = hostChatTitle(row, t);
    // under All the row says its folder; a folder's pill already names it
    const context = [row.status === "error" ? t("Error") : null, shownFolder === "all" ? row.cwd ? basename(row.cwd) : t("No folder") : null, chatAge(row, now, t)].filter(Boolean).join(" · ");
    const menuOpen = menu?.session === row.session;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { session: row.session, anchor, point, previousFocus });
    return <li key={row.session} className={`agent-item host-chat-item${row.session === selected ? " is-selected" : ""}`} data-host-session={row.session}
      onMouseDownCapture={actions ? (event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); } : undefined}
      onContextMenu={actions ? (event) => onRowContextMenu(event, toggleMenu) : undefined}>
      <button type="button" className="agent-select agent-row" aria-current={row.session === selected ? "true" : undefined} title={[title, row.cwd].filter(Boolean).join("\n")} onClick={() => onOpen(row.session)}>
        <AgentRowBody mark="copilot" markKind="Copilot" title={title} name={null} context={context} tokens={[]} status={hostChatStatus(row)} />
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
      <div ref={surface} className="modal new-session-modal all-agents" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("All agents on {pc}", { pc: machineName })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body all-agents-body">
          <label className="all-agents-search">
            <Search aria-hidden="true" />
            <input className="input" type="search" value={query} aria-label={t("Search agents")} placeholder={t("Search agents")}
              autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {line && <p className="field-hint" role="status">{line}</p>}
          {/* a folder's chats only, as VS Code's sessions view filters by workspace; All is every folder */}
          {pills.length > 1 && <div className="all-agents-pills" role="radiogroup" aria-label={t("Folders")}>
            {[{ cwd: "all" as Pick, count: pills.reduce((sum, pill) => sum + pill.count, 0) }, ...pills].map((pill) => {
              const name = pill.cwd === "all" ? t("All") : pill.cwd ? basename(pill.cwd) : t("No folder");
              const on = shownFolder === pill.cwd;
              return <button key={pill.cwd ?? "\0none"} type="button" role="radio" aria-checked={on} className={`all-agents-pill${on ? " is-on" : ""}`}
                title={pill.cwd !== "all" && pill.cwd ? pill.cwd : undefined} onClick={() => setFolder(pill.cwd)}>
                <span className="all-agents-pill-name">{name}</span><span className="all-agents-pill-count">{pill.count}</span>
              </button>;
            })}
          </div>}
          {current.length === 0 && archived.length === 0 && <p className="agent-empty" role="status">{t(words === "" ? "No agents yet" : "No agents match")}</p>}
          {current.map((group) => <section key={group.age} className="all-agents-group" aria-label={t(AGE_LABEL[group.age])}>
            <h3 className="sidebar-section-label all-agents-age">{t(AGE_LABEL[group.age])}</h3>
            <ul className="agent-list">{group.chats.map(item)}</ul>
          </section>)}
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
      {menu && menuRow && actions && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={hostChatTitle(menuRow, t)} subtitle={menuRow.cwd ?? undefined}
        items={hostChatItems(actions, { machineId, chat: menuRow }, t)} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  );
}
