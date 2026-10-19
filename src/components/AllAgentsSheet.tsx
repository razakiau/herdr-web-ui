/**
 * "All agents on <PC>…": every host chat of a PC, the ones the sidebar does not place too
 * (lib/hostPlacement.ts). A sheet (a bottom sheet on a phone) with a search box; the chats grouped by
 * folder, newest first, each with when it last changed ("2 days ago"), and the archived ones last,
 * folded. Picking one opens it, as a tab of its workspace or its folder row.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Ellipsis, X } from "lucide-react";

import "./NewSessionDialog.css";
import "./Sidebar.css";
import "./AgentSidebar.css";
import "./AllAgentsSheet.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
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

/** The chats grouped by folder, newest folder first and newest chat first within each; null folders last. */
function byFolder(rows: readonly HostChatRow[]): { cwd: string | null; chats: HostChatRow[] }[] {
  const groups = new Map<string | null, HostChatRow[]>();
  for (const row of [...rows].sort((a, b) => modified(b) - modified(a))) {
    const key = row.cwd ? row.cwd.replace(/(.)\/$/, "$1") : null;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  return [...groups].map(([cwd, chats]) => ({ cwd, chats })).sort((a, b) => (a.cwd === null ? 1 : 0) - (b.cwd === null ? 1 : 0));
}

export function AllAgentsSheet({ machineId, machineName, pc, selected, onOpen, onClose }: AllAgentsSheetProps) {
  const t = useT();
  const id = useId();
  const now = useMinuteClock();
  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
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
  const found = useMemo(() => pc.chats.filter((row) => words === "" || row.title.toLowerCase().includes(words) || (row.cwd ?? "").toLowerCase().includes(words)), [pc.chats, words]);
  const current = byFolder(found.filter((row) => !row.archived));
  const archived = found.filter((row) => row.archived).sort((a, b) => modified(b) - modified(a));
  const line = pc.host ? hostLine(pc.host, t) : null;
  // a search looks in the archived ones too: what it finds there is shown
  const showArchived = archivedOpen || (words !== "" && archived.length > 0);

  const item = (row: HostChatRow) => {
    const title = hostChatTitle(row, t);
    const context = [row.status === "error" ? t("Error") : null, chatAge(row, now, t)].filter(Boolean).join(" · ");
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
          <input className="input all-agents-search" type="search" value={query} aria-label={t("Search agents")} placeholder={t("Search agents")}
            autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
          {line && <p className="field-hint" role="status">{line}</p>}
          {current.length === 0 && archived.length === 0 && <p className="agent-empty" role="status">{t(words === "" ? "No agents yet" : "No agents match")}</p>}
          {current.map((group) => <section key={group.cwd ?? ""} className="all-agents-group" aria-label={group.cwd ?? t("No folder")}>
            <h3 className="sidebar-section-label all-agents-folder" title={group.cwd ?? undefined}>{group.cwd ? basename(group.cwd) : t("No folder")}</h3>
            <ul className="agent-list">{group.chats.map(item)}</ul>
          </section>)}
          {archived.length > 0 && <section className="all-agents-group" aria-label={t("Archived")}>
            <button type="button" className="sidebar-section-label all-agents-archived" aria-expanded={showArchived} onClick={() => setArchivedOpen(!showArchived)}>
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
