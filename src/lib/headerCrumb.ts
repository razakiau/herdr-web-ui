/**
 * Where the selected pane is, as the header says it on its one line: PC › workspace › folder.
 * The folder shows as its last name, and only when nothing beside it already says that name (the
 * title, the PC when the line names it, the workspace): it is what tells two worktrees of one
 * workspace apart, and "api › api" told nobody anything. The full path is not lost: it is in the header's tooltip and
 * the first thing in its More menu, which is where a touch screen reads it.
 */
import { folderName } from "./paneName.ts";

export interface HeaderCrumb {
  machine: string;
  /** whether the line names the PC: one PC needs no name (the sidebar leaves it out too) */
  showMachine: boolean;
  workspace: string;
  /** the folder's last name, or null when another part already says it (or there is no folder) */
  folder: string | null;
  /** "PC › workspace": the More menu's first line */
  place: string;
  /** the folder written out, as herdr reports it: the More menu's second line */
  path: string | null;
  /** the context's tooltip: workspace › title, then the full path */
  tooltip: string;
}

export function headerCrumb(input: { machine: string; machineCount: number; workspace: string; title: string; cwd: string | null | undefined }): HeaderCrumb {
  const machine = input.machine.trim();
  const workspace = input.workspace.trim();
  const title = input.title.trim();
  // trimmed only to tell an absent folder: a name may end in a space, and is shown as it is
  const path = input.cwd?.trim() ? input.cwd : null;
  const name = path === null ? null : folderName(path);
  // only a name the line shows can have said the folder's: a hidden PC name says nothing
  const showMachine = input.machineCount > 1;
  const said = name === null || [title, showMachine ? machine : null, workspace].includes(name);
  return {
    machine,
    showMachine,
    workspace,
    folder: said ? null : name,
    place: `${machine} › ${workspace}`,
    path,
    tooltip: path === null ? `${workspace} › ${title}` : `${workspace} › ${title} · ${path}`,
  };
}

/**
 * A host chat's crumb: PC › folder (a host chat has no workspace; its folder is where it works),
 * the folder by its last name. With no folder, the PC alone.
 */
export function hostHeaderCrumb(input: { machine: string; machineCount: number; title: string; cwd: string | null | undefined; name?: string }): HeaderCrumb {
  const machine = input.machine.trim();
  const title = input.title.trim();
  const path = input.cwd?.trim() ? input.cwd : null;
  const folder = path === null ? null : folderName(path);
  return {
    machine,
    showMachine: input.machineCount > 1,
    workspace: "",
    // the header's name (hostHeaderName) said it already: "zhomelab › zhomelab" tells nobody anything
    folder: folder === input.name?.trim() ? null : folder,
    place: folder === null ? machine : `${machine} › ${folder}`,
    path,
    tooltip: path === null ? title : `${title} · ${path}`,
  };
}

/**
 * Whether the pane column draws the chat: the header's pane zone and the tab strip take the
 * chat's surface only then. A pane herdr could not restore draws a placeholder on the terminal's
 * surface whatever the lens, and so does no pane at all.
 */
export function showsChat(pane: { restore_error?: unknown } | null | undefined, view: string): boolean {
  return !!pane && !pane.restore_error && view === "chat";
}

/**
 * The header's name over a host chat: where it works, as a pane's header says its workspace. The
 * chat's own title is on its tab already; it is the header's name only when nothing else is known.
 */
export function hostHeaderName(input: { workspace: string | null | undefined; cwd: string | null | undefined; title: string }): string {
  const workspace = input.workspace?.trim();
  if (workspace) return workspace;
  return input.cwd?.trim() ? folderName(input.cwd) : input.title;
}
