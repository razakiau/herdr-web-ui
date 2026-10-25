/**
 * VS Code's checkpoints on a host chat, for the phone. Restore Checkpoint (Start Over on the first
 * message) opens a sheet that names what it does, as VS Code's confirmation does: the files the
 * agent changed since, put back as they were, and the turns after it set aside until the next
 * send. Once restored, a bar over the composer says so and offers Redo.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Redo2, RotateCcw, X } from "lucide-react";

import "./HostCheckpoint.css";

import type { HostCheckpoint } from "../../shared/host-chats.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

const reason = (cause: unknown): string => cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause);

/** Each file once, its lines summed, across this checkpoint and every later one: what a restore puts back. */
export function filesSince(list: readonly HostCheckpoint[], turn: string): HostCheckpoint["files"] {
  const at = list.findIndex((each) => each.turn === turn);
  const files = new Map<string, { path: string; added: number; removed: number }>();
  for (const checkpoint of at < 0 ? [] : list.slice(at)) {
    for (const file of checkpoint.files) {
      const seen = files.get(file.path);
      if (seen) { seen.added += file.added; seen.removed += file.removed; } else files.set(file.path, { ...file });
    }
  }
  return [...files.values()];
}

const nameOf = (path: string): { name: string; dir: string } => {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
};

export function CheckpointSheet({ first, files, later, busy, onStop, onRestore, onClose }: {
  first: boolean;
  /** a turn runs: the host restores nothing then (VS Code's check), so the sheet offers Stop first */
  busy: boolean;
  onStop(): void;
  files: HostCheckpoint["files"];
  /** how many of the chat's messages, this one included, go when the next message is sent */
  later: number;
  onRestore(): Promise<void>;
  onClose(): void;
}) {
  const t = useT();
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: cancel });
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  const restore = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try { await onRestore(); } catch (cause) { setError(reason(cause)); setPending(false); }
  };
  const title = t(first ? "Start over?" : "Restore checkpoint?");
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal checkpoint-sheet" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} disabled={pending} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <p className="checkpoint-sheet-lede" id={`${id}-body`}>
            {files.length === 0
              ? t(first ? "The agent changed no files in this chat. Its messages are set aside, and go when you send." : "The agent changed no files since this message. It and the messages after it are set aside, and go when you send.")
              : t(files.length === 1 ? "This puts back {n} file the agent changed, as it was before this message." : "This puts back {n} files the agent changed, as they were before this message.", { n: files.length })}
          </p>
          {files.length > 0 && <ul className="checkpoint-files" aria-label={t("Files to put back")}>
            {files.map((file) => {
              const { name, dir } = nameOf(file.path);
              return <li key={file.path} className="checkpoint-file" title={file.path}>
                <FileText className="checkpoint-file-icon" aria-hidden="true" />
                <span className="checkpoint-file-name">{name}</span>
                <span className="checkpoint-file-dir">{dir}</span>
                <span className="checkpoint-file-lines"><span className="chat-diff-add">+{file.added}</span> <span className="chat-diff-del">−{file.removed}</span></span>
              </li>;
            })}
          </ul>}
          {files.length > 0 && <p className="checkpoint-sheet-note">{t("Changes you made to these files by hand since are overwritten.")}</p>}
          <p className="checkpoint-sheet-note">{t(later === 1 ? "Your message goes back in the box. Sending removes it from the chat; Redo puts everything back." : "Your message goes back in the box. Sending removes it and the {n} after it from the chat; Redo puts everything back.", { n: later - 1 })}</p>
          {busy && <p className="checkpoint-sheet-busy" role="status">{t("The agent is working. Stop it to restore this checkpoint.")}</p>}
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          {busy && <button type="button" className="btn btn-secondary" onClick={onStop}>{t("Stop")}</button>}
          <button type="button" className="btn btn-primary checkpoint-sheet-restore" disabled={pending || busy} onClick={() => void restore()}>
            <RotateCcw aria-hidden="true" />{t(pending ? "Restoring…" : first ? "Start Over" : "Restore")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** The bar over the composer while a checkpoint is restored: what happened, and Redo. */
export function CheckpointBar({ files, onRedo }: { files: number; onRedo(): Promise<void> }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redo = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try { await onRedo(); } catch (cause) { setError(reason(cause)); } finally { setPending(false); }
  };
  return <div className="checkpoint-bar" role="status">
    <RotateCcw className="checkpoint-bar-icon" aria-hidden="true" />
    <span className="checkpoint-bar-text">
      {t("Checkpoint restored")}
      {files > 0 && <span className="checkpoint-bar-files"> · {t(files === 1 ? "{n} file" : "{n} files", { n: files })}</span>}
    </span>
    {error && <span className="checkpoint-bar-error" role="alert">{error}</span>}
    <button type="button" className="btn btn-ghost checkpoint-bar-redo" disabled={pending} onClick={() => void redo()}>
      <Redo2 aria-hidden="true" />{t(pending ? "Redoing…" : "Redo")}
    </button>
  </div>;
}
