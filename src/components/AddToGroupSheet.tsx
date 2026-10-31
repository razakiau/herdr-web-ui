/**
 * Chat groups (ZAC-265), "Add to group" for one chat, a sheet from the chat's ⋯: the groups as a
 * pick (those about the chat's own folder first, then the most recent, each "4 chats · zhomelab ·
 * Oct 25"), the one it is in ticked; "New group…" starts a group with the chat in it; "Split here"
 * (only in a group) moves this chat and the ones after it to a new group; Add puts it in the picked
 * group, out of the one it was in. A refusal is said in the sheet, which stays.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Split } from "lucide-react";

import "./NewSessionDialog.css";
import "./AddToGroupSheet.css";

import type { GroupsAnswer } from "../../shared/groups.ts";
import { chatKey, groupOf, groupsApi, type ChatRef } from "../lib/groups.ts";
import { basename, errorText, type HostPc } from "../lib/hostChats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { GroupNameSheet, groupActive, groupFolder, rowsByKey, shortDate } from "./GroupsSheet.tsx";

export function AddToGroupSheet({ chat, answer, hostChats, onClose }: {
  chat: ChatRef;
  answer: GroupsAnswer | null;
  hostChats: ReadonlyMap<string, HostPc>;
  onClose(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const current = groupOf(answer, chat.pc, chat.session);
  const [picked, setPicked] = useState<number | null>(current?.id ?? null);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const own = rows.get(chatKey(chat.pc, chat.session));
  const ownFolder = own?.repo ?? own?.cwd;
  const here = ownFolder ? basename(ownFolder) : null;
  const groups = useMemo(() => (answer?.groups ?? []).map((group) => ({ group, folder: groupFolder(group, rows), active: groupActive(group, rows) }))
    .sort((a, b) => Number(b.folder === here && here !== null) - Number(a.folder === here && here !== null) || b.active - a.active), [answer, rows, here]);
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
    if (picked === null || picked === current?.id) { onClose(); return; }
    void run(() => groupsApi.add(picked, chat));
  };

  return createPortal(<>
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; dialog.current = node; }} className="modal new-session-modal add-to-group" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Add to group")}</h2></header>
        <div className="modal-body add-to-group-body">
          <p className="add-to-group-hint" id={`${id}-hint`}>{current
            ? t("This chat is in {name}. Pick another group to move it, or split the group here.", { name: current.name })
            : t("This chat isn't in a group. Pick one, or start a new group with it.")}</p>
          {groups.length > 0 && <div className="add-to-group-list" role="radiogroup" aria-label={t("Groups")}>
            {groups.map(({ group, folder, active }) => {
              const on = picked === group.id;
              const count = group.members.length;
              const when = now - active < 15 * 60_000 ? t("active now") : shortDate(active, locale);
              const sub = [t(count === 1 ? "1 chat" : "{n} chats", { n: count }), folder, when].filter(Boolean).join(" · ");
              return <button key={group.id} type="button" role="radio" aria-checked={on} className={`add-to-group-row${on ? " is-on" : ""}`} onClick={() => setPicked(group.id)}>
                <span className="add-to-group-check" aria-hidden="true">{on && <Check />}</span>
                <span className="add-to-group-text">{group.name}<small>{sub}</small></span>
              </button>;
            })}
          </div>}
          <hr className="add-to-group-divider" />
          <button type="button" className="add-to-group-row" disabled={busy} onClick={() => setNaming(true)}>
            <Plus className="add-to-group-icon is-accent" aria-hidden="true" />
            <span className="add-to-group-text">{t("New group…")}</span>
          </button>
          {current && <button type="button" className="add-to-group-row" disabled={busy} onClick={() => void run(() => groupsApi.split(chat))}>
            <Split className="add-to-group-icon" aria-hidden="true" />
            <span className="add-to-group-text">{t("Split here")}<small>{t("this chat and the ones after it start a new group")}</small></span>
          </button>}
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer add-to-group-footer">
          <button type="button" className="btn btn-primary add-to-group-go" disabled={busy || picked === null} onClick={add}>
            {picked !== null && current !== null && picked !== current.id ? t("Move") : t("Add")}
          </button>
        </footer>
      </div>
    </div>
    {naming && <GroupNameSheet title={t("New group")} name="" action={t("Create")} onClose={() => setNaming(false)}
      onSave={async (name) => { await groupsApi.create(name, chat); onClose(); }} />}
  </>, document.body);
}
