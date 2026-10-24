/**
 * A host chat's + (ZAC-207 redesign): what can go with the message, the chat's own folder before
 * the device's files. Camera and Photos open the device's picker narrowed to pictures (a web page
 * cannot list the gallery itself); "Files in this folder" searches the chat's folder as "@" does and
 * adds the same chip; the clipboard's picture, when the browser lets the page read it; the files this
 * chat sent lately, one tap each. The settings and model sheets' grouped-list look (HostChatView.css).
 */
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronLeft, ChevronRight, Clipboard, FileText, FolderOpen, Image, Search, Upload, X } from "lucide-react";

import type { AttachApi } from "./Composer.tsx";
import { useT } from "../lib/i18n.ts";
import { fetchHostFiles } from "../lib/hostChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

const RECENT_MAX = 3;
const recentKey = (machineId: string, session: string): string => `herdr-web-ui:host-attached:${machineId}:${session}`;

/** the chat's last few sent file paths (an "@" or folder pick), newest first */
export function recentAttached(machineId: string, session: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recentKey(machineId, session)) ?? "[]");
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function rememberAttached(machineId: string, session: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const next = [...paths, ...recentAttached(machineId, session)].filter((each, index, all) => all.indexOf(each) === index).slice(0, RECENT_MAX);
  try { window.localStorage.setItem(recentKey(machineId, session), JSON.stringify(next)); } catch { /* the sheet still works without it */ }
}

const canReadClipboard = (): boolean => typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";

interface Props { machineId: string; session: string; api: AttachApi; onClose(): void }

export function AttachSheet({ machineId, session, api, onClose }: Props) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  const [page, setPage] = useState<"main" | "folder">("main");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [clipNote, setClipNote] = useState<string | null>(null);
  const recent = recentAttached(machineId, session);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { if (page === "folder") { setPage("main"); return true; } onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (page !== "folder") return;
    let live = true;
    const timer = window.setTimeout(() => {
      void fetchHostFiles(machineId, session, query).then((next) => { if (live) { setFiles(next); setFailed(false); } }, () => { if (live) { setFiles([]); setFailed(true); } });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [machineId, page, query, session]);

  const pick = (path: string): void => { api.addPicked(path); onClose(); };
  const device = (opts?: { accept?: string; capture?: boolean }): void => { onClose(); api.pickFiles(opts); };
  const paste = async (): Promise<void> => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((each) => each.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        api.addFile(new File([blob], `clipboard.${type.split("/")[1] ?? "png"}`, { type }));
        onClose();
        return;
      }
      setClipNote(t("No picture on the clipboard"));
    } catch {
      setClipNote(t("The browser didn't allow reading the clipboard"));
    }
  };

  const title = page === "folder" ? t("Files in this folder") : t("Add to chat");
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal host-picker attach-sheet" role="dialog" aria-modal="true" aria-label={t("Add to chat")} tabIndex={-1} data-page={page}>
        <header className="modal-header">
          {page === "folder" && <button type="button" className="icon-button" aria-label={t("Back")} title={t("Back")} onClick={() => setPage("main")}><ChevronLeft aria-hidden="true" /></button>}
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body host-picker-body">
          {page === "main" ? <>
            <div className="attach-tiles">
              <button type="button" className="attach-tile" onClick={() => device({ accept: "image/*", capture: true })}><Camera aria-hidden="true" />{t("Camera")}</button>
              <button type="button" className="attach-tile" onClick={() => device({ accept: "image/*" })}><Image aria-hidden="true" />{t("Photos")}</button>
            </div>
            <div className="host-picker-group">
              <button type="button" className="host-picker-option" onClick={() => { setPage("folder"); setFiles(null); }}>
                <FolderOpen className="host-picker-option-icon" aria-hidden="true" />
                <span className="host-picker-option-text"><span className="host-picker-option-name">{t("Files in this folder")}</span></span>
                <ChevronRight className="host-picker-check attach-chevron" aria-hidden="true" />
              </button>
              {canReadClipboard() && <button type="button" className="host-picker-option" onClick={() => { void paste(); }}>
                <Clipboard className="host-picker-option-icon" aria-hidden="true" />
                <span className="host-picker-option-text">
                  <span className="host-picker-option-name">{t("Paste from clipboard")}</span>
                  {clipNote && <span className="host-picker-option-id" role="status">{clipNote}</span>}
                </span>
              </button>}
              <button type="button" className="host-picker-option" onClick={() => device()}>
                <Upload className="host-picker-option-icon" aria-hidden="true" />
                <span className="host-picker-option-text"><span className="host-picker-option-name">{t("Upload from device")}</span></span>
              </button>
            </div>
            {recent.length > 0 && <section className="host-picker-group" aria-label={t("Recent in this chat")}>
              <p className="host-picker-provider">{t("Recent in this chat")}</p>
              {recent.map((path) => <button key={path} type="button" className="host-picker-option attach-recent" onClick={() => pick(path)}>
                <FileText className="host-picker-option-icon" aria-hidden="true" />
                <span className="host-picker-option-text"><span className="host-picker-option-name attach-path">{path}</span></span>
              </button>)}
            </section>}
          </> : <>
            <div className="host-picker-head">
              <label className="host-picker-search">
                <Search aria-hidden="true" />
                <input className="input" type="search" value={query} placeholder={t("Search files")} aria-label={t("Search files")} onChange={(event) => setQuery(event.target.value)} />
              </label>
            </div>
            {files === null && <p className="host-picker-state" role="status">{t("Loading…")}</p>}
            {failed && <p className="host-picker-error" role="alert">{t("Couldn't list this folder's files")}</p>}
            {files !== null && !failed && files.length === 0 && <p className="host-picker-state">{t("No files match")}</p>}
            {files !== null && files.length > 0 && <div className="host-picker-group">
              {files.map((path) => <button key={path} type="button" className="host-picker-option" aria-label={path} onClick={() => pick(path)}>
                <FileText className="host-picker-option-icon" aria-hidden="true" />
                <span className="host-picker-option-text">
                  <span className="host-picker-option-name attach-path">{path.split("/").pop()}</span>
                  {path.includes("/") && <span className="host-picker-option-id">{path.slice(0, path.lastIndexOf("/"))}</span>}
                </span>
              </button>)}
            </div>}
          </>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
