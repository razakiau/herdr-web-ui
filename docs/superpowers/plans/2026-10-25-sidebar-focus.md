# Sidebar focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents list first (needs you → working → unread → rest, with place, "now" and time in state), quiet PCs folded under Other PCs by rules the user can override, and the standing filter replaced by a search icon.

**Architecture:** Pure functions in `src/lib/` carry every rule (fold, agent grouping, "now" line, duration), each unit-tested; the components only draw them. The server stamps `status_since` on each pane when its status really changes and sends it on the frames and the snapshot it already sends.

**Tech Stack:** Bun 1.4.2 (`bun test`), React, TypeScript, lucide-react; demos in `scripts/*.ts`.

**Spec:** `docs/superpowers/specs/2026-10-25-sidebar-focus-design.md`; mockup `.superpowers/brainstorm/67279-1792928688/content/sidebar-v2.html`.

## Global Constraints

- Tokens only (`--status-working/blocked/done/idle`, `--text*`, `--bg-*`, `--accent`); every theme through them. Default theme is Codex.
- No rule between sections, no coloured side bar; hover `--side-hover`, selection `--bg-hover`.
- Every new user-facing string goes through `t()` with ja/ko/zh in the i18n files (`i18n.test` must stay green).
- localStorage keys: `ovis:pcs-kept-open` (exists), `ovis:pcs-kept-folded` (new). Search query is never stored.
- Any `server/` or `shared/` change bumps `REMOTE_BUNDLE_VERSION` in `shared/machines.ts` by 1 (1058 → 1059), once, in the task that changes them.
- DESIGN.md is updated in the same commit as the behaviour it describes.
- Usage footer: gear left, `UsageMeters` chips right-aligned with `+N` last at the right edge (owner, 2026-10-25); the chips and popover are otherwise unchanged.

## Review Focus

1. **Old bridge without `status_since`:** the row shows no time and nothing throws (Task 1 test: `formatSince(undefined)` → `null`; Task 4 renders no `.agent-since`).
2. **The user folds the PC he is on:** it must fold (his choice wins) but the selected row stays reachable. Expected: fold wins only when it is *not* the current PC; the current PC is always open (Task 2 test `current PC stays open even if kept folded`).
3. **A PC removed while in either kept list:** pruned, never listed in Other PCs' names (Task 2 test `stale ids are ignored`).
4. **Status flapping with the same value** (herdr re-sending `working`): `status_since` must not reset (Task 1 server test `same status keeps since`).
5. **Search Escape on the phone:** Escape with text clears it; Escape on an empty field closes search, not the drawer (Task 5 demo step).

---

### Task 1: `status_since` from the server, and duration formatting

**Files:**
- Modify: `shared/protocol.ts:51` (HerdrPane) and `:940` (pane-status frame): add `status_since?: number` (epoch ms, when the pane entered `agent_status`).
- Create: `server/status-since.ts`, test `server/status-since.test.ts`
- Modify: `server/core/status.ts` (`clientSnapshot` ~153, `paneStatus` ~192): attach `status_since`.
- Modify: `src/lib/snapshot.ts` `applyPaneStatus`, `src/lib/useMachineRoster.ts:213`: carry `message.status_since`.
- Create: `src/lib/since.ts`, test `src/lib/since.test.ts`
- Modify: `shared/machines.ts:10`: `"1059"`.

**Interfaces:**
- Produces: `class StatusSince { note(paneId: string, status: AgentStatus, now?: number): number; of(paneId: string): number | undefined; forget(paneId: string): void }` and `formatSince(since: number | undefined, now: number): string | null`.

- [ ] **Step 1: Failing tests.** `status-since.test.ts`: `first note stamps now`; `same status keeps since` (note working @1000, note working @5000 → `of` = 1000); `new status restamps` (working @1000, blocked @5000 → 5000); `forget drops it`. `since.test.ts`: `formatSince(undefined, n)` → `null`; 30 s → `"now"`; 4 min → `"4m"`; 59 min → `"59m"`; 2 h 5 min → `"2h"`; 3 d → `"3d"`; a future `since` (clock skew) → `"now"`.
- [ ] **Step 2: Run** `bun test server/status-since.test.ts src/lib/since.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** both. `StatusSince` is a `Map<string, {status, since}>`. In `status.ts`, one instance; `paneStatus()` calls `note()` and adds `status_since`; `clientSnapshot` adds `status_since: since.note(pane.pane_id, settledStatus)` for every pane; forget on pane exit where other per-pane maps are forgotten. `applyPaneStatus` gets a trailing `since?: number` parameter and stores it on the pane only when defined.
- [ ] **Step 4: Run** the two files plus `bun test server/core src/lib/snapshot` → PASS; bump `REMOTE_BUNDLE_VERSION` to `"1059"`.
- [ ] **Step 5: Commit** `feat(status): say since when each pane is in its state (ZAC-233)`.

### Task 2: Fold rules the user can override

**Files:**
- Modify: `src/lib/hostPlacement.ts:79-103`, test `src/lib/hostPlacement.test.ts`

**Interfaces:**
- Produces: `foldPcs(machines: Machine[], current: string | null, prefs: { active(id: string): boolean; keptOpen: readonly string[]; keptFolded: readonly string[] }): { open: Machine[]; folded: Machine[] }` (replaces the old signature), `foldPc(lists: PcLists, id: string): PcLists`, `openPc(lists: PcLists, id: string): PcLists` where `interface PcLists { keptOpen: string[]; keptFolded: string[] }`. Keep `keptPcs` for pruning.

- [ ] **Step 1: Failing tests** (machines a..e, roster order kept in both outputs):
  - `two PCs never fold`;
  - `current, active and kept-open are open, the rest folded` (current a, active c, keptOpen e → open a,c,e; folded b,d);
  - `kept folded beats active` (active c, keptFolded c → c folded);
  - `current PC stays open even if kept folded`;
  - `current is temporary` (current b, not kept → open; then current a → b folded);
  - `stale ids are ignored` (keptOpen ["gone"] → no effect);
  - `foldPc removes from keptOpen and adds to keptFolded`, `openPc the reverse`, both idempotent.
- [ ] **Step 2: Run** `bun test src/lib/hostPlacement.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `active` means working or needs you (from `pcActivity`: `working + asking > 0`).
- [ ] **Step 4: Run** → PASS. Mutation: remove the keptFolded check, rerun, `kept folded beats active` must fail; restore.
- [ ] **Step 5: Commit** `feat(sidebar): fold quiet PCs, and let the user's fold win (ZAC-233)`.

### Task 3: Agent groups and the "now" line

**Files:**
- Modify: `src/lib/agentRoster.ts`, test `src/lib/agentRoster.test.ts`
- Create: `src/lib/agentNow.ts`, test `src/lib/agentNow.test.ts`

**Interfaces:**
- Consumes: `shownStatus` (sidebarOrder.ts), `PlanSummary`.
- Produces: `agentRoster(...)` returns `{ pinned, rest }` with `rest` ordered by group rank `blocked 0, working 1, unread done 2, else 3`, stable inside a group (existing Workspaces/Activity order); `agentRoster` takes a new option `status(machine: Machine, pane: HerdrPane): AgentStatus | undefined` (the shown status, so a read DONE ranks as rest). `agentNow(pane: HerdrPane, t: Translate): { text: string; tone: "ask" | "plain" } | null`.

- [ ] **Step 1: Failing tests.** agentRoster: `needs you, then working, then unread, then the rest`; `pinned stay in the card whatever their status`; `order inside a group is kept` (two working, Workspaces order). agentNow: blocked → `{ text: t("Waiting for you"), tone: "ask" }`; plan `{done:2,total:5,current:"Run tests"}` → `"Run tests · 2/5"`; plan without current → `"2/5"`; no plan, no wait → `null`.
- [ ] **Step 2: Run** `bun test src/lib/agentRoster.test.ts src/lib/agentNow.test.ts` → FAIL.
- [ ] **Step 3: Implement.** No transcript reads; the ask is the fixed phrase (the alert carries the details). Add "Waiting for you" to i18n with ja/ko/zh.
- [ ] **Step 4: Run** → PASS, plus `bun test src/i18n`.
- [ ] **Step 5: Commit** `feat(agents): list what needs you first, and say what each is doing (ZAC-233)`.

### Task 4: Draw it: agents above PCs, new row, Other PCs, footer

**Files:**
- Modify: `src/components/MachineSidebar.tsx:140-200` (order, fold wiring, storage, footer), `src/components/AgentSidebar.tsx` (`AgentRowBody`: place line with PC in `.agent-pc`, `agentNow`, `.agent-since` under the state glyph; head summary), `src/components/AgentSidebar.css`, `src/components/OtherPcsFold.tsx` (dim names line `services, node2 +6`, needs-you dot), `src/components/Sidebar.css` (one scroll list: drop the Agents dock/half-height cap; footer chips right-aligned), `src/components/UsageMeters.css` if the alignment lives there.
- Test: `src/components/AgentSidebar.test.tsx`, `scripts/ui-regression.ts`, `scripts/sidebar-machine-layout.ts`, `scripts/sidebar-machine-removal.ts`.
- Modify: `DESIGN.md` "Sidebar roster row and footer" and "Plan meters" to the new rules.

**Interfaces:**
- Consumes: Tasks 1–3 (`formatSince`, `foldPcs`/`foldPc`/`openPc`, `agentRoster` with `status`, `agentNow`).
- Produces: storage `ovis:pcs-kept-folded`; PC header menu items **Keep open** / **Fold into Other PCs** (replacing Put back); `.agent-since` refreshed by one `setInterval(60_000)` in AgentSidebar.

- [ ] **Step 1: Failing tests.** AgentSidebar.test: `a blocked agent renders first with the ask in .agent-now.is-ask`; `a row with status_since shows "4m" in .agent-since` (fake now); `a row without status_since has no .agent-since`; `head summary says "1 needs you" and "2 working" and omits zero counts`.
- [ ] **Step 2: Run** `bun test src/components/AgentSidebar.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Remove the effect that auto-keeps the selected and asking PCs (MachineSidebar ~155-159): the current PC is open by `foldPcs`, the asking ones are open as active. Migration: an existing `ovis:pcs-kept-open` is kept as is. One-line mode: place and now on the line, time only in the state cell's `title`.
- [ ] **Step 4: Run** `bun test src/components src/lib` → PASS; then `bun scripts/ui-regression.ts`, `bun scripts/sidebar-machine-layout.ts`, `bun scripts/sidebar-machine-removal.ts` after updating their expectations (agents above PCs; Other PCs names line; fold menu labels) → each prints its pass line.
- [ ] **Step 5: Visual check** in the dev server (`bun run dev`) at 1280×800 and 390×844, dark and light Codex plus amber: compare with the mockup; tabular numerals, focus ring inside rows, no clipped titles. Run `impeccable` craft-floor checks on the built result.
- [ ] **Step 6: Commit** `feat(sidebar): agents first, quiet PCs folded, real usage strip on the right (ZAC-233)`.

### Task 5: Search icon replaces the filter row

**Files:**
- Modify: `src/components/MachineSidebar.tsx:170-182` (filter block → top row with title, search and `+`; field shown only while open), `src/components/Sidebar.css:84` (`.sidebar-filter` → `.sidebar-search`), `src/lib/sidebarFilter.ts` (results: also return each hit's place for the dim line; folded PCs searched), `DESIGN.md` filter paragraph.
- Test: `src/lib/sidebarFilter.test.ts`, `scripts/sidebar-filter.ts`, `scripts/header-more.ts` if it counts header buttons.

**Interfaces:**
- Consumes: `sidebarFilter(query, machines, selection, t, branches)`; Task 2's fold output (search ignores it).
- Produces: `searchPlace(machineName: string, folded: boolean, t: Translate): string` → `"node2 · folded in Other PCs"` or `"desktop"`.

- [ ] **Step 1: Failing tests.** sidebarFilter.test: `a hit on a folded PC is returned`; `searchPlace names the fold`. Demo `sidebar-filter.ts`: click the magnifier (`aria-label` "Search workspaces and agents") → field focused; type → results grouped **Agents**, **Workspaces**; Escape with text clears and keeps it open; Escape on empty closes search and the drawer stays open; reload → closed and empty.
- [ ] **Step 2: Run** `bun test src/lib/sidebarFilter.test.ts` and `bun scripts/sidebar-filter.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep every privacy rule from DESIGN.md's filter paragraph (no storage, nothing typed elsewhere reaches it, terminal keeps keys). Highlight matches with an accent underline, not colour. New strings via `t()` with ja/ko/zh.
- [ ] **Step 4: Run** both → PASS; `bun test` whole suite → green; all 48 demos with the same two known upstream failures (context-menu-inputs, terminal-autoswitch).
- [ ] **Step 5: Commit** `feat(sidebar): search behind an icon instead of a standing filter (ZAC-233)`.

### Task 6: Ship

- [ ] **Step 1:** Bump done in Task 1 (1059). Push `ovis-port` → fork `zhomelab` (fast-forward). Pin the new commit in zhomelab `ansible/roles/herdr_web/defaults/main.yml` with a comment, on the PR #204 branch.
- [ ] **Step 2:** `--check --diff` → read → apply → re-run `changed=0`; leak-scan the logs.
- [ ] **Step 3:** Live on herdr.lab, phone and desktop: 12/12 PCs connected and bridges at 1059; a blocked agent on a folded PC puts the dot on Other PCs; a working one opens its PC; folding it by hand keeps it folded; the time ticks; search finds a workspace on a folded PC.
- [ ] **Step 4:** Commit zhomelab pin, push, SHAs match; ZAC-233 comment and handoff updated.
