# Sidebar focus: agents first, quiet PCs folded

**Ticket:** ZAC-233 (follow-up) · **Mockup:** `.superpowers/brainstorm/67279-1792928688/content/sidebar-v2.html`

## Problem

With 12 PCs the sidebar is a long list of places, most of them with nothing running. What the
owner looks for (what needs me, what is working, for how long, where, doing what) is in the Agents
list, which sits under the workspaces, docked at the bottom and capped at half the height. The
filter field takes a full row at the top all the time.

## Decisions (agreed with the owner, 2026-10-25)

1. **Agents first.** The Agents list moves above the PCs and scrolls with them in one list (no
   separate docked pane, no half-height cap). Its head reads **Agents** with a dim summary on the
   right: `● 1 needs you  ● 2 working` (dots in `--status-blocked` / `--status-working`, words
   carry the meaning, counts tabular). The summary leaves out zero counts; with nothing to report
   it is absent.
2. **Order inside Agents:** needs you → working → unread finish → the rest, each group in the
   chosen Agents order (Workspaces or Activity). Pinned agents keep their card above all of it.
   This replaces DESIGN.md's "a pane that waits for an answer is not listed apart or moved up".
3. **Agent row** (two lines, same grid: lead | body | state):
   - lead: the agent's brand mark (unchanged);
   - line 1: the pane's title, `--text-strong` 500; rested rows (done and read, idle) `--text` 400;
   - line 2, `--fs-xs` `--text-dim`: **PC** (in `--text`, 500) · project (workspace) · *now*.
     *Now* is, in order: the waiting ask in `--status-blocked` when blocked; the plan's
     `current` step (`PlanSummary.current`, with `done/total` when it has one); the plugin
     tokens line; else nothing. The PC is shown only when two or more PCs are registered, as today;
   - state cell, row 1: the existing compact glyph (spinner working, dot + tint ring blocked,
     check done, hollow ring idle);
   - state cell, row 2: **how long** in that state (`4m`, `38m`, `2h`, `3d`), tabular, dim;
     `--status-blocked` while blocked.
   One-line mode (Settings → Sidebar rows) keeps one line: title, then the place, then *now*,
   with the time in the state cell's tooltip only.
4. **PCs below**, under a dim **PCs** head. Fold rules (replaces `foldPcs`):
   - with one or two PCs nothing folds (as today);
   - **open:** the current PC, every PC with an agent working or needing you, and every PC the user
     kept open;
   - **folded:** everything else, under **Other PCs**, plus every PC the user folded by hand, even
     while one of its agents needs you (his choice beats the default). Other PCs then wears the
     needs-you dot, and its dim line names the first PCs inside (`services, node2 +6`);
   - **opening a chat on a folded PC** shows that PC while it is the current one and folds it back
     when the selection leaves, unless the user kept it open meanwhile. (Owner left this to me; it
     is the existing "current PC stays open" rule, so no new state.)
   - The user's choices live on this device, as today: `ovis:pcs-kept-open` plus a new
     `ovis:pcs-kept-folded`; keeping a PC open removes it from the folded list and vice versa.
   - A folded PC header still shows its rolled-up state glyph and a dim workspace count.
5. **Search, not a standing filter.** The filter row goes; a magnifier sits in the sidebar's top
   row beside `+`. It opens the field in place (focus moves there), Escape or the cross closes and
   clears it. While open, results replace the lists, grouped **Agents** then **Workspaces**, each
   row on the same grid with a dim line saying where it lives (`node2 · folded in Other PCs`).
   It searches every PC, folded ones included, with the existing matcher and facets
   (`lib/sidebarFilter.ts`); matches are underlined in the accent, not recoloured. Every privacy
   rule of today's filter stays (state never stored, nothing typed reaches it, terminal keeps keys).
6. **Footer unchanged in substance.** The real multi-provider usage strip stays, with the gear on
   the left and the chips right-aligned for symmetry with the top row (owner, 2026-10-25): one chip
   per account (provider mark, mono percent, 2 px bar, red from 80% used), `+N`, and the popover
   with every limit per account. The mockup's two plain bars were wrong; nothing of the usage
   detail is lost.

## Visual rules (from DESIGN.md, kept)

Codex theme by default, every theme through tokens only; one grid; sections parted by space and a
dim `--fs-sm` head, never a rule; hover and selection one neutral fill at two strengths; no
coloured side bars; brand marks the only colour that is not a state; amber/accent only for focus,
the caret and the search highlight. Lucide icons for PC kinds (laptop, monitor, server), folder,
chevron, search, plus, layers (Other PCs). Fades at a cut list's lower edge as today.

## Data

- **How long:** nothing records when a pane entered its state. The server stamps
  `status_since` (epoch ms) on each pane when its `agent_status` changes, and sends it with the
  pane status it already pushes; a bridge that predates it sends none and the row shows no time.
  The client renders it relative and refreshes once a minute. Server change → bundle bump.
- **Now:** existing fields only (`waiting`, `PlanSummary`, `tokens`); no new transcript reads.
- **Fold:** pure function over machines, current id, `isActive(id)` (working or needs you),
  kept-open and kept-folded lists; unit-tested like `foldPcs`.

## Out of scope

Host chats' own list, the header, tab strip and palette; any change to herdr's order; upstream
proposal wording (step 6 decides whether this goes upstream).

## Testing

- Unit: the new fold function (each rule, the user's fold beating needs-you, temporary current);
  agent ordering groups; duration formatting; `status_since` stamped only on a real change.
- Demo scripts: update sidebar-filter, sidebar-machine-layout, sidebar-machine-removal and
  ui-regression for search-as-icon and the new order; a mutation check that the fold test fails
  when the user-fold rule is removed.
- Live: herdr.lab with 12 PCs, phone and desktop, dark and light: a blocked agent on a folded PC
  shows the dot on Other PCs; a working one opens its PC; time ticks.
