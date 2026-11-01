/**
 * A host chat's own actions, the same on every surface that shows one (its tab, its row in the
 * Agents list, in "All agents on <PC>…", and the header's ⋯ while it is open): Pin / Unpin (this
 * app's pins), Rename…, Mark as read / unread, Mark as done / Restore, Delete…. Only a host chat
 * has them; a pane's tab and row keep their own menus.
 *
 * App.tsx owns them (HostChatActionsContext): the tracker whose rows they edit (lib/hostChats.ts
 * HostPcs: at once, put back on a refusal), the one rename sheet and delete confirm, and the line
 * that says a refusal. A tab renames in place, as a pane's tab does; the other surfaces ask in the
 * small rename sheet.
 */
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, GalleryVerticalEnd, Mail, MailOpen, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { HostChatRow } from "../../shared/host-chats.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { RowMenuItem } from "./RowMenu.tsx";

/** What a surface hands the menu: the chat, its PC, and whether it is pinned here. */
export interface HostChatRef { machineId: string; chat: HostChatRow }

export interface HostChatActions {
  pinned(machineId: string, session: string): boolean;
  togglePin(machineId: string, session: string): void;
  /** the rename sheet, for a surface with no field of its own */
  askRename(target: HostChatRef): void;
  /** a name typed in place (a tab's field): sent, and a refusal said */
  rename(machineId: string, session: string, title: string): void;
  setRead(machineId: string, session: string, read: boolean): void;
  setArchived(machineId: string, session: string, archived: boolean): void;
  /** whether the chat is an open tab of its agent host workspace (lib/hostWorkspaces.ts) */
  isTab(machineId: string, session: string): boolean;
  /** its tab closed: hidden, never archived; the workspace closes with its last tab */
  closeTab(machineId: string, session: string): void;
  /** its tab moved to `boundary` among `shown`, the host tabs as its strip draws them (lib/hostWorkspaces.ts moveTab) */
  moveTab(machineId: string, shown: readonly string[], session: string, boundary: number): void;
  /** the confirm, naming the chat; Delete there deletes it */
  askDelete(target: HostChatRef): void;
  /** the rename sheet or the delete confirm is up: a sheet under it leaves Back to it (lib/sheetHistory.ts) */
  asking: boolean;
  /** the "Add to group" sheet for the chat (lib/groups.ts), only while Settings → Chat groups is on */
  addToGroup?(machineId: string, session: string): void;
}

export const HostChatActionsContext = createContext<HostChatActions | null>(null);
export const useHostChatActions = (): HostChatActions | null => useContext(HostChatActionsContext);

/** The chat's title as the app shows it. */
export const hostChatTitle = (chat: HostChatRow, t: Translate): string => chat.title.trim() || t("Copilot chat");

/**
 * The menu's items for one chat. `rename` overrides how Rename… starts (a tab's field in place);
 * without one it opens the sheet. Pin first, as an Agents row's menu has it; Close tab while it is
 * one (it hides the tab and loses nothing, so it never asks); Delete last, apart.
 */
export function hostChatItems(actions: HostChatActions, target: HostChatRef, t: Translate, rename?: () => void): RowMenuItem[] {
  const { machineId, chat } = target;
  const pinned = actions.pinned(machineId, chat.session);
  return [
    pinned
      ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => actions.togglePin(machineId, chat.session) }
      : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => actions.togglePin(machineId, chat.session) },
    { id: "rename-chat", label: t("Rename…"), icon: Pencil, run: rename ?? (() => actions.askRename(target)) },
    chat.unread
      ? { id: "mark-read", label: t("Mark as read"), icon: MailOpen, run: () => actions.setRead(machineId, chat.session, true) }
      : { id: "mark-unread", label: t("Mark as unread"), icon: Mail, run: () => actions.setRead(machineId, chat.session, false) },
    ...(actions.isTab(machineId, chat.session) ? [{ id: "close-tab", label: t("Close tab"), icon: X, run: () => actions.closeTab(machineId, chat.session) }] : []),
    chat.archived
      ? { id: "restore", label: t("Restore"), icon: ArchiveRestore, run: () => actions.setArchived(machineId, chat.session, false) }
      : { id: "mark-done", label: t("Mark as done"), icon: Archive, run: () => actions.setArchived(machineId, chat.session, true) },
    ...(actions.addToGroup ? [{ id: "add-to-group", label: t("Add to group…"), icon: GalleryVerticalEnd, run: () => actions.addToGroup?.(machineId, chat.session) }] : []),
    { id: "delete-chat", label: t("Delete…"), icon: Trash2, danger: true, divider: true, run: () => actions.askDelete(target) },
  ];
}

/**
 * "Rename chat": one field, the chat's name in it, Save. An empty name is not sent (VS Code's own
 * "Title cannot be empty"). A sheet on a phone, as the app's other small dialogs are.
 */
export function RenameHostChatSheet({ title, onSave, onClose }: { title: string; onSave(title: string): void; onClose(): void }) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(title);
  const [empty, setEmpty] = useState(false);
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
  useEffect(() => { window.requestAnimationFrame(() => field.current?.select()); }, []);
  const save = (): void => {
    const next = value.trim();
    if (next === "") { setEmpty(true); return; }
    onClose();
    if (next !== title.trim()) onSave(next);
  };
  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form ref={surface} className="modal new-session-modal host-chat-rename" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        onSubmit={(event) => { event.preventDefault(); save(); }}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Rename chat")}</h2></header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{t("Chat name")}</span>
            <input ref={field} className="input" value={value} maxLength={MAX_LABEL_CHARS} autoComplete="off" spellCheck={false} aria-invalid={empty || undefined}
              onChange={(event) => { setValue(event.target.value); setEmpty(false); }} />
          </label>
          {empty && <p className="confirm-error" role="alert">{t("A chat needs a name.")}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("Save")}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
