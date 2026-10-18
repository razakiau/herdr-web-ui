import type { ReactNode } from "react";

import { fileLineTarget, splitFilePaths } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";
import { FileGlyph } from "./FileGlyph.tsx";

/**
 * Text past this many characters stays plain: a whole tool output can be megabytes, and every
 * path in it would be an element.
 */
export const FILE_LINK_LIMIT = 256 * 1024;
/** Nor does a text with more paths than this link any: a listing of thousands would be thousands of buttons. */
export const FILE_LINK_COUNT = 500;

/** Whether `text` links its paths at all: short enough, and not a listing of thousands. */
export function linksFilePaths(text: string): boolean {
  return text.length <= FILE_LINK_LIMIT && splitFilePaths(text).filter((part) => typeof part !== "string").length <= FILE_LINK_COUNT;
}

/**
 * A file path the viewer opens: a button that reads as the text or code it replaced. `pill` (the
 * vscode style only): VS Code's file pill instead, its icon, its name and its line (`a.ts:12`).
 */
export function FilePathLink({ path, code, open, pill = false }: { path: string; code: boolean; open: (path: string) => void; pill?: boolean }) {
  const t = useT();
  if (pill) {
    const target = fileLineTarget(path);
    const name = target.path.replace(/\/+$/, "").split("/").at(-1) || target.path;
    return <button type="button" className="markdown-file is-pill" title={t("Open {path}", { path })} onClick={() => open(path)}>
      <FileGlyph name={name} className="markdown-file-icon" /><span>{name}</span>{target.line !== null && <span className="markdown-file-line">:{target.line}</span>}
    </button>;
  }
  const label = code ? <code>{path}</code> : path;
  return <button type="button" className={`markdown-file${code ? " is-code" : ""}`} title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button>;
}

/**
 * `text` with the file paths in it as links to the viewer (a tool's output, a log in a code
 * block): `/tmp/shot/t0.png (1600, 1000)` opens the picture. Plain where nothing can open one.
 */
export function linkFilePaths(text: string, open: ((path: string) => void) | null): ReactNode {
  if (open === null || text.length > FILE_LINK_LIMIT) return text;
  const parts = splitFilePaths(text);
  if (parts.length === 1 && typeof parts[0] === "string") return text;
  if (parts.filter((part) => typeof part !== "string").length > FILE_LINK_COUNT) return text;
  return parts.map((part, index) => typeof part === "string" ? part : <FilePathLink key={index} path={part.path} code={false} open={open} />);
}
