import { BookOpen, CircleAlert, CircleSlash, CircleX, FolderSearch, Pencil, Plug, Search, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";

import type { ToolKind } from "./toolGroupSummary.ts";

/**
 * The lucide stand-ins for the codicons VS Code draws per call (chatToolPartUtilities.ts
 * `getToolInvocationIcon` at 6d62b1d): terminal, book, search, pencil, mcp, tools.
 */
const KIND_ICON: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  read: BookOpen,
  search_text: Search,
  search_files: Search,
  list: FolderSearch,
  problems: CircleAlert,
  edit: Pencil,
  mcp: Plug,
  other: Wrench,
};

/** A call's icon: its kind's, or the outcome's when it failed (error) or was skipped (circle-slash). */
export function toolIcon(kind: ToolKind, state: "done" | "failed" | "skipped" | "running"): LucideIcon {
  if (state === "failed") return CircleX;
  if (state === "skipped") return CircleSlash;
  return KIND_ICON[kind];
}
