/**
 * The title of a chat that continues another (ZAC-267): Hand off & continue and Continue start a
 * chat whose first message is `/resume <topic>` or `/harness:resume <uuid>`, and the host titled it
 * from that. The bridge names it `<old title> → 2` instead, `→ N+1` when the old one is already a
 * continuation. Null when the old chat has no real title (empty, or VS Code's draft "Session"): the
 * host's own title is left.
 */
const DRAFT_TITLE = "Session";
const NUMBERED = /^(.*\S)\s+→\s+(\d+)$/;

export function nextHandoffTitle(old: string): string | null {
  const title = old.trim().replace(/\s+/g, " ");
  if (title === "" || title === DRAFT_TITLE) return null;
  const numbered = NUMBERED.exec(title);
  return numbered ? `${numbered[1]} → ${Number(numbered[2]) + 1}` : `${title} → 2`;
}
