import { BookOpen, CircleAlert, CircleSlash, CircleX, FolderSearch, Pencil, Search, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";

import { McpIcon } from "../components/McpIcon.tsx";

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
  // MCP's own mark, not VS Code's plug codicon (owner, ZAC-228)
  mcp: McpIcon as unknown as LucideIcon,
  other: Wrench,
};

/** A call's icon: its kind's, or the outcome's when it failed (error) or was skipped (circle-slash). */
export function toolIcon(kind: ToolKind, state: "done" | "failed" | "skipped" | "running"): LucideIcon {
  if (state === "failed") return CircleX;
  if (state === "skipped") return CircleSlash;
  return KIND_ICON[kind];
}
