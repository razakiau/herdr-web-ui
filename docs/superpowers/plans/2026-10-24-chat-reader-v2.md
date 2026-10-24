# Chat reader v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host chats read like VS Code/Claude: folded work groups, subagent cards you can open,
scrolling tables, a per-answer changes line and quiet footer, and the session's todo list above
the composer.

**Architecture:** The bridge adds `todos` to `HostChatRead` from the Copilot session's own
SQLite store. Everything else is rendering in `ChatView` / `SubagentRow` / `Markdown` /
`HostChatView`, driven by data the read already carries (`checkpoints`, turn parts).

**Tech Stack:** Bun 1.4.2, TypeScript, React, `bun:sqlite`, `bun test`, the Playwright demo
scripts in `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-24-chat-reader-v2-design.md` (ZAC-228)

## Global Constraints

- Base: fork branch `zhomelab` (contains a74a0e0 and 6a7ab849). Branch:
  `zack/zac-228-herdr-web-ui-chat-reader-v2-folded-work-subagent-cards-todos`.
- `REMOTE_BUNDLE_VERSION` in `shared/machines.ts`: `"1051"` → `"1052"` (the bridge changes).
- Every new string goes through `t()` with ko/ja/zh entries; the i18n test passes.
- Tokens only (`--bg-panel`, `--radius-lg`, `--text-strong`, `--text-dim`, `--accent`,
  `--notice`, `--border`, `--border-strong`, `--fs-xs`); lucide icons.
- Each demo assert added must fail when its feature is removed (mutation run, recorded in the
  commit's `Verified:`).
- Restore and Fork exist only in the user bubble's ⋯, never on an answer.
- DESIGN.md is updated in the task that changes the look it describes.
- Bun: `export PATH=$(ls -d ~/.local/share/mise/installs/bun/1.4.2/bin):$PATH`. Remove
  `tsconfig.tsbuildinfo` before committing. `bun test src` has ~20 pre-existing failures:
  compare against the baseline list, don't chase them.

## Review Focus

1. **A chat with no todos table, or no session-state folder** (most host chats, and any
   `ahp-session:` chat): the read must carry no `todos` and never throw. Test in Task 1.
2. **The session.db is locked or mid-write by the CLI** (WAL): open read-only, and a failed read
   keeps the last good list instead of blanking the bar. Test in Task 1.
3. **A running subagent that ends while the reader has it open**: it stays open (the reader's
   choice wins); one the reader never touched closes. Test in Task 4.
4. **A turn whose checkpoint lists files but no +/−** (binary or rename): the changes line still
   shows the file count and omits zero counts. Test in Task 6.
5. **A table inside a subagent card or a list item on a 390 px phone**: it scrolls inside its own
   wrapper and never widens the page. Demo assert in Task 7.

---

### Task 1: Bridge reads the session's todos

Source (checked 2026-10-24): a host chat `copilotcli:/<uuid>` or `ahp-session:/<uuid>` has
`$COPILOT_HOME/session-state/<uuid>/session.db` (25/25 recent host chats had the folder); the
`todos` table appears once the agent writes one (schema: `id TEXT PK, title, description,
status CHECK IN ('pending','in_progress','done','blocked'), created_at, updated_at`).

**Files:**
- Create: `server/agent-host/todos.ts`, `server/agent-host/todos.test.ts`
- Modify: `shared/host-chats.ts` (`HostChatRead`), `server/agent-host/chats.ts` (`readFrom`,
  signature shape ~1073–1109), `server/agent-host/routes.ts:549` (pass todos in)
- Modify: `shared/machines.ts` (bundle 1052)

**Interfaces:**
- Produces: `export interface HostTodo { id: string; title: string; status: "pending" | "in_progress" | "done" | "blocked" }` in `shared/host-chats.ts`;
  `HostChatRead.todos?: HostTodo[]` (absent when none).
- Produces: `export function readSessionTodos(session: string, home?: string): HostTodo[] | null`
  in `server/agent-host/todos.ts`. `null` = no store/table; `[]` = table empty. `home` defaults
  to `defaultCopilotHome()` from `server/copilot.ts`.
- Produces: `ReadContext.todos?(): HostTodo[] | null` in `chats.ts`; `readFrom` sets
  `todos` when it returns a non-empty list and puts it in the signature shape.

- [ ] **Step 1: Write the failing tests** in `server/agent-host/todos.test.ts` with a temp home:
  - `"reads todos in rowid order"`: create `session-state/<uuid>/session.db` with the schema
    above, insert 3 rows (done, in_progress, pending); `readSessionTodos("copilotcli:/<uuid>", home)`
    equals those 3 `{id,title,status}` in insert order.
  - `"null without a folder or table"`: unknown uuid → `null`; folder with a db lacking `todos` → `null`.
  - `"rejects a session id that escapes"`: `"copilotcli:/../x"` → `null` (uuid must match
    `/^[0-9a-f-]{36}$/i`).
  - `"keeps the last good list when the read fails"`: read once, then replace the file with
    garbage bytes; the second read returns the first list.
  - In `chats.test.ts`: `"todos change the signature"`: two `readFrom` calls whose context
    differs only in `todos()` give different `signature`s, and `todos` is absent when `todos()` returns `[]`.
- [ ] **Step 2: Run** `bun test server/agent-host/todos.test.ts server/agent-host/chats.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `readSessionTodos`: `new Database(path, { readonly: true })`,
  `SELECT id, title, status FROM todos ORDER BY rowid`, close it. Cache per path keyed on the
  db and `-wal` mtimes so an unchanged store isn't reopened; on error return the cached list
  (or `null`). Wire `todos` into `contextOf` (routes.ts:455) for the session being read, and
  into `readFrom`.
- [ ] **Step 4: Run** the same tests → PASS; `bun run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(host-chats): send the session's todos on a chat read (ZAC-228)`.

### Task 2: Todo bar above the composer, and "Updated todos" rows

**Files:**
- Create: `src/components/HostTodoBar.tsx`, `src/components/HostTodoBar.css`, `src/components/HostTodoBar.test.tsx`
- Modify: `src/components/HostChatView.tsx:350` (render the bar above `HostSessionPills`)
- Modify: `src/lib/todos.ts` (`toolKind`: `manage_todo_list`, `update_todo` → a new kind `"host"`; `todoCallSummary` returns `t("Updated todos")` for it)
- Modify: i18n ko/ja/zh, DESIGN.md (composer section)

**Interfaces:**
- Consumes: `HostTodo`, `HostChatRead.todos` (Task 1).
- Produces: `export function HostTodoBar({ todos, busy }: { todos: readonly HostTodo[] | undefined; busy: boolean }): JSX.Element | null`;
  `export function currentTodo(todos: readonly HostTodo[]): HostTodo | null` (first `in_progress`, else first `pending`).

- [ ] **Step 1: Write the failing tests** (`HostTodoBar.test.tsx`, render to static markup):
  - closed shows `"Todos 3/7"` (done/total) and the current task's title; the progress element's
    style width is `"42.9%"` for 3/7.
  - `currentTodo` prefers the first `in_progress` over an earlier `pending`.
  - renders `null` for `undefined`, `[]`, and all-done with `busy=false`; renders for all-done with `busy=true`.
  - open (`defaultOpen` prop for the test) lists one row per todo with `data-status` per state;
    `blocked` rows carry the notice class.
  - `todos.test.ts`: `todoCallSummary` of a `manage_todo_list` call is `"Updated todos"` with no digits.
- [ ] **Step 2: Run** `bun test src/components/HostTodoBar.test.tsx src/lib/todos.test.ts` → FAIL.
- [ ] **Step 3: Implement** the bar: a button head (`ListChecks` icon, title, dim ellipsized current
  task, caret), a 3 px `--accent` progress track, an `AnimatedHeight` list with `Check` /
  `CircleDot` / `Circle` / `TriangleAlert` icons; done rows dim and struck through. Open state via
  `useChatRowToggle("todos", false)`.
- [ ] **Step 4: Run** the tests → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(host-chats): show the chat's todo list above the composer (ZAC-228)`.

### Task 3: Work groups fold, and lose their per-group time

**Files:**
- Modify: `src/components/ChatView.tsx` `VscodeWorkBlockView` (~752–795), `VscodeWork` (~798–820)
- Test: `src/components/ChatView.turn.test.tsx`

**Interfaces:**
- Produces: `export function groupStartsOpen(index: number, groups: number, live: boolean, textAfter: boolean): boolean`
  in ChatView.tsx: true only for the last group of a live turn with no text after it.

- [ ] **Step 1: Write the failing tests:** `groupStartsOpen(1, 2, true, false) === true`;
  `(0, 2, true, false) === false`; `(1, 2, true, true) === false`; `(1, 2, false, false) === false`.
  A rendered finished turn with 2 groups has no `.work-block-time` and no `"Worked for"` text in
  any group head, and both groups are closed.
- [ ] **Step 2: Run** `bun test src/components/ChatView.turn.test.tsx` → FAIL.
- [ ] **Step 3: Implement:** `VscodeWork` computes `textAfter` per group from `all` and passes
  `defaultOpen={groupStartsOpen(...)}`; the reader's toggle still wins (`chosenOpen ?? defaultOpen`).
  Remove the `work-block-time` span. A running tool row uses the host's `invocationMessage`
  when present (present tense), else today's text.
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(chat): fold finished work groups like VS Code (ZAC-228)`.

### Task 4: Subagent card

**Files:**
- Modify: `src/components/SubagentRow.tsx`, its CSS, `src/components/SubagentRow.test.tsx`
- Modify: `src/components/ChatView.tsx:1159` (drop the "`x` has completed" system line for a subagent the turn shows as a card)
- Modify: i18n ko/ja/zh ("Asked", "Work", "Answer"), DESIGN.md

**Interfaces:**
- Consumes: today's `SubagentRowProps` (`part`, `live`, `readChat`, `renderTurn`, `now`), unchanged.
- Produces: `export function subagentSections(turns: ConversationTurn[]): { asked: string | null; work: ConversationTurn[]; answer: string | null }`
  in SubagentRow.tsx: `asked` = first user text, `answer` = the last turn's final assistant text,
  everything else (narration and later turns) in `work`.

- [ ] **Step 1: Write the failing tests:**
  - `subagentSections` on a 2-turn fixture: `asked` is the prompt, `answer` the last text, and the
    narration between tools is in `work` (nothing dropped: total text length preserved).
  - closed card markup: has the name in `.subagent-name`, the description, the time, and no model;
    open markup has captions `Asked`, `Work`, `Answer` and the model.
  - running + untouched → open; finished + untouched → closed; running, reader closed it, then it
    finishes → stays closed; reader opened it, then it finishes → stays open.
  - a subagent part inside the subagent's work renders a nested `.subagent-card`.
- [ ] **Step 2: Run** `bun test src/components/SubagentRow.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the card (`--bg-panel`, `--radius-lg`, border), sections with the
  11 px caps captions, Work drawn through `renderTurn` with the `vscode` style. Keep
  `RevealedSubagentContext` opening and scrolling to it.
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(chat): subagents open as cards with what was asked, the work and the answer (ZAC-228)`.

### Task 5: Tables scroll sideways

**Files:**
- Modify: `src/components/Markdown.tsx:347`, `src/components/ChatView.css:~670`, DESIGN.md

**Interfaces:** none new; the wrapper class is `.md-table-scroll`.

- [ ] **Step 1: Write the failing test** (Markdown test or ChatView.turn.test): a markdown table
  renders inside `div.md-table-scroll > table`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** wrapper with `overflow-x: auto`; table `width: max-content; min-width: 100%`;
  cells `min-width: 6em`, wrap at word boundaries; no outer border or vertical rules; header
  semibold with a `--border-strong` bottom rule; rows `--border` rules. On ≤ 600 px the wrapper
  bleeds to the pane edge with negative inline margin equal to the reply padding.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(chat): let wide tables scroll instead of crushing (ZAC-228)`.

### Task 6: End of an answer: changes line, footer ⋯, user bubble ⋯, checkpoint line

**Files:**
- Create: `src/components/TurnChanges.tsx` (+ test)
- Modify: `src/components/ChatView.tsx` `Turn` (~1089–1190): footer, bubble actions, checkpoint line
- Modify: `src/components/HostSessionPills.tsx` (export the diff sheet opener with a path filter)
- Modify: `src/components/HostChatView.tsx` (pass `checkpoints` per turn and the opener)
- Modify: i18n ko/ja/zh, DESIGN.md

**Interfaces:**
- Consumes: `HostCheckpoint { turn; files: {path, added, removed}[] }` (shared/host-chats.ts:166), `checkpointRows` (src/lib/hostCheckpoints.ts).
- Produces: `export function changesLine(files: HostCheckpoint["files"]): { files: number; added: number; removed: number }`;
  `HostSessionPills` gains `openChanges?: (paths: string[] | null) => void` exposed via a
  `ChangesSheetContext` in `HostSessionPills.tsx` (`null` = whole chat).
- Produces: `TurnProps.changes?: HostCheckpoint["files"] | null` and `TurnProps.onViewChanges?(paths: string[]): void`.

- [ ] **Step 1: Write the failing tests:**
  - `changesLine` sums counts; the rendered line reads `"2 files changed"` with `+30` and `−3`, and
    for files with 0/0 shows no `+0`/`−0`.
  - a finished answer's footer has one `⋯` button whose menu holds exactly "Copy as markdown" and
    "Copy as plain text"; no Restore/Fork anywhere in an assistant turn.
  - a user bubble's `⋯` holds Copy, "Restore to before this message" and "Fork from here"
    (Fork absent on the first message, as today).
  - a `.chat-checkpoint-line` appears after a turn with `changes`, not after one without, and not
    after the last turn; clicking it calls `onCheckpoint` with the next user turn.
- [ ] **Step 2: Run** `bun test src/components/TurnChanges.test.tsx src/components/ChatView.turn.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Footer: `--fs-xs --text-dim`, time · duration · model, copy, ⋯; on
  `(hover: hover)` it's `opacity: 0` until the turn is hovered or focused-within. "View" calls
  `onViewChanges(paths)`, which opens today's diff sheet filtered to those paths.
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(chat): end each answer with what it changed and a quiet footer (ZAC-228)`.

### Task 7: MCP calls read like VS Code (owner, 2026-10-24)

Today an MCP row says only `mcp_tool_call`: the host sends `summary` and `past` equal to the
raw tool name. Live (591b2f3f): `{name: "mcp_tool_call", tool_id: "lab-search-mcp_tool_call",
past: "mcp_tool_call", input: {tool_name: "mobbin-search_screens", arguments: {...}}}`.
VS Code shows "Ran `<tool>`" with the server beside it, and opens to Input and Output blocks.

**Files:**
- Create: `src/lib/mcpCall.ts` (+ `mcpCall.test.ts`)
- Modify: `src/components/ChatView.tsx` `VscodeWorkRow` (~698): label and detail for `kind === "mcp"`
- Modify: `src/lib/toolGroupSummary.ts` (the group sentence counts MCP calls: "Ran 2 tools"), i18n, DESIGN.md

**Interfaces:**
- Produces: `export function mcpCall(part: { name: string; tool_id?: string; input: string; past?: string; summary: string }): { tool: string; server: string | null; args: unknown } | null`.
  `server` = `tool_id` minus the `-<name>` suffix when it ends with it. A gateway proxy
  (`name` is `mcp_tool_call` / `call_tool` / `mcp_tool_search`, i.e. input has a string
  `tool_name` / `name`) gives the inner tool and `args` = its `arguments`; else `tool` = `name`,
  `args` = the parsed input. `past`/`summary` equal to `name` count as absent.

- [ ] **Step 1: Write the failing tests:** the live fixture above gives
  `{tool: "mobbin-search_screens", server: "lab-search", args: {platform: "ios", …}}`;
  `mcp_tool_search` with `{query}` gives `tool: "mcp_tool_search"`; a host `past` that differs
  from the name (real words) wins in the row label; a rendered row reads "Ran
  `mobbin-search_screens`" with a dim "lab-search" and, opened, an "Input" block of pretty JSON
  and an "Output" block; a failed call reads "Failed `x`" with the error icon.
- [ ] **Step 2: Run** `bun test src/lib/mcpCall.test.ts src/components/ChatView.turn.test.tsx` → FAIL.
- [ ] **Step 3: Implement**, keeping MCP rows unfolded (`neverFolded`), as VS Code does.
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(chat): name the MCP tool and server a call ran, like VS Code (ZAC-228)`.

### Task 8: Demo asserts, mutation proof, deploy

**Files:**
- Modify: `scripts/host-chats-demo-regression.ts` (fixtures + asserts), `.handoffs/herder-ui-web.md` (zhomelab), `ansible/roles/herdr_web/defaults/main.yml` (zhomelab pin)

- [ ] **Step 1: Add fixtures and asserts** at 390 px and desktop: a folded finished group; a
  subagent card closed, open, nested; a 6-column table whose `.md-table-scroll` has
  `scrollWidth > clientWidth` while `document.documentElement.scrollWidth <= innerWidth`
  (including one inside a subagent card); the changes line and the footer ⋯ menu; the todo bar
  closed ("Todos 3/7") and open (7 rows); an MCP row reading "Ran `mobbin-search_screens`".
- [ ] **Step 2: Run** `perl -e 'alarm 900; exec @ARGV' bun scripts/host-chats-demo-regression.ts`
  (async, ~5 min) → all PASS (54 old + new). Also `scripts/prompt-dock-demo-regression.ts` → 26 PASS.
- [ ] **Step 3: Mutation run:** for each new assert, disable its feature (one at a time, file
  copied to /tmp and restored by `cp`) and confirm that assert FAILS. Record the table.
- [ ] **Step 4: Commit** `test(chat): prove reader v2 in the demo (ZAC-228)` with the mutation table in `Verified:`.
- [ ] **Step 5: Final review** by one fresh reviewer over the branch diff against `fork/zhomelab`.
- [ ] **Step 6: Deploy** as ZAC-226: fast-forward fork `zhomelab` (`--force-with-lease=zhomelab:<old sha>`),
  new zhomelab branch from origin/main pinning the commit, `ansible/herdr-web.yml` twice
  (changed=3 then 0), leak scan, live: open a host chat with todos on herdr.lab and see the bar
  with the same count as `sqlite3 … 'select count(*) from todos'`.
- [ ] **Step 7:** Update ZAC-228 (shipped, PR links), the handoff, stop the `mockserve2` server.
