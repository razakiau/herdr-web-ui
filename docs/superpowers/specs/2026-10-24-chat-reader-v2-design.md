# Chat reader v2 (host chats, phone first)

**Ticket:** ZAC-228 · **Status:** draft for approval · **Mockup:** session file `reader-v2.html`
(served at http://192.168.1.47:8765/reader-v2.html during review)

## Why

The owner's verdict: "it's not bad, but it could be better". He wants what the other harnesses
do (Claude, Codex, VS Code). He also noticed that VS Code tracks a todo list while it works, and
we don't show one at all.

What the research turned up:

- **VS Code 1.143** (source on `microsoft/vscode` main, `chatContentParts/`):
  - A run of tool calls collapses to one sentence once the answer resumes ("Edited 2 files, ran 3
    commands"; `chatToolGroupSummary.ts`, `persistentProgressVerbosity: compact`).
  - A subagent is one collapsible block: "Ran subagent", then its prompt and nested steps
    (`chatSubagentContentPart.ts`).
  - Each answer ends with "N files changed" and its line counts (`chatChangesSummaryPart.ts`).
  - Checkpoints are a dashed separator between turns.
  - Wide tables scroll sideways (`chatMarkdownTableScrolling.ts`).
  - The footer is one quiet line (time • elapsed • model).
  - A **Todos (x/y)** widget sits above the input, showing the current task, collapsible
    (`chatTodoListWidget.ts`).
- **Claude (Mobbin):** one grey line stands for all of the work, the answer reads as a document,
  and tables have only thin row rules.
- **Ours (screens `task-5-*`, 390 px):**
  - Host chats already group calls into VS Code's sentence (`VscodeWorkBlockView`), so that part
    exists.
  - A subagent shows its whole chat inline: description, a user bubble, the answer, then
    "Subagent explore has completed" in mono.
  - Tables wrap into 4 narrow columns of 3–5 lines a cell.
  - Restore, fork and copy sit under every user bubble, and MD and TXT under every answer.
  - "2 files +30 −3" is a pill above the composer, away from the answer it belongs to.
  - **Copilot's todos never show.** Copilot doesn't keep them in a tool call: it writes them to
    the `todos` table of the session's own SQLite (`~/.copilot/session-state/<id>/session.db`:
    id, title, description, status pending|in_progress|done|blocked) and raises the SDK event
    `session.todos_changed`. The agent host doesn't forward either one, so nothing reaches the app.
    The app can already draw lists for Claude Code `TodoWrite`, Codex `update_plan` and omp
    `todo` (`src/lib/todos.ts`), but not this one.

## Goals

1. The work reads as one line per stretch of work. It streams while running and folds when the
   answer resumes. Every step can still be opened, and so can a subagent's whole work, as deep
   as it goes (owner: "I want to be able to expand on the work of a subagent obviously").
2. A subagent is a card: name, task, time. Opened, it shows **Asked**, **Work** (its steps, in
   the same rows) and **Answer**.
3. Tables keep their columns and scroll sideways on a narrow screen.
4. Each answer ends with its changes ("2 files changed +30 −3 · View") and one quiet footer
   (time · duration · model, copy, ⋯).
5. Copilot host chats show their todo list as VS Code does: a bar above the composer with
   "Todos 3/7", the current task and a thin progress bar, which opens to the whole list.
6. Phone and desktop draw the same reader. Desktop gets hover for the footer actions.

## Non-goals

- Pane chats (Claude Code, Codex, omp) keep their reader. Anything that comes for free through
  the shared parts (tables, the subagent card) is fine, but nothing is designed for them here.
- No editing of todos from the app (VS Code's widget has none either, apart from Clear).
- No new data source for diffs: "View" opens the diff sheet that exists today.
- No thinking-style setting. Thinking stays a folded row inside the work.

## Anti-goals

- Losing detail. Every step, output and subagent turn reachable today stays reachable, at most
  one tap further.
- A fold that moves the page under the reader's thumb. The rule today is that a block the
  reader opened or focused stays open (`keepOpen`), and it stays.
- Breaking the composer work (ZAC-207) or the context popup (ZAC-226).

## Approaches considered (owner picked A, "for the best UX")

- **A. Live, then fold (chosen).** Steps stream one per line while the agent works, then fold into
  the summary line once text resumes or the turn ends. This is VS Code's `compact` mode and
  Claude's default. You can watch it work, and a finished chat is short.
- **B. Always folded.** One line from the start ("Working… ›"). The calmest option, but you can't
  see progress without tapping, which is the main reason to open herdr on a phone.
- **C. Always open.** Today's behaviour for the live turn. A long agent run buries the answer.

## Design

### 1. Work (host chats, `VscodeWork` / `VscodeWorkBlockView`)

The grouping is already there. What changes:

- **Fold rule:** a group is open while it is the live, last group and nothing has been written
  after it. It folds once text follows it or the turn ends, unless the reader opened or focused
  it (`useChatRowToggle` memory). Today, `defaultOpen` for an older finished group must already be
  false: check that, and assert it in the demo.
- **Head:** drop "Worked for …" from each group (the turn footer carries the time once). Keep the
  sentence, the edits' +/− and the caret.
- **Live row wording:** a running call reads in the present ("Reading charge.ts"), from the host's
  `invocationMessage` when it has one, and done reads `past` as today.

### 2. Subagent card (`SubagentRow`)

- **Closed:** a bordered `--bg-panel` card, radius `--radius-lg`. It shows the icon (spinner while
  running), the **name** in `--text-strong`, the description in `--text-dim`, then the time and the
  caret. The model moves into the open body. While running, the latest activity line stays under
  the head (as today).
- **Open:** three captioned sections, using the 11 px caps captions from the grouped lists. Text
  the subagent wrote between its steps, and any later turns, go in **Work** as the same folded
  groups with their narration (my call: nothing is lost):
  - **Asked**: the prompt, as markdown, which today is shown as a user bubble.
  - **Work**: its turns' work, drawn with the same `VscodeWork` rows. A subagent's subagent is a
    card inside it, so it nests to any depth.
  - **Answer**: its final text.
  The "Subagent explore has completed" system line goes; the card's state says it.
- A running subagent opens by itself and stays open until it ends, unless the reader closes it.
  A finished one is closed.
- Reveal (`RevealedSubagentContext`) still opens and scrolls to it.

### 3. Tables (`Markdown.tsx`, `.markdown table`)

- The table sits in a scroll wrapper (`overflow-x: auto`) as wide as the reply, with the wrapper
  bleeding to the screen edges on a phone. Cells don't wrap below a sensible width
  (`min-width` per column from the header, text wraps at word boundaries only, as today's rule).
- Look: no outer box, no vertical rules; the header is semibold with a `--border-strong` rule
  and rows have `--border` rules (Claude, VS Code).
- A table that fits stays as it is. Nothing scrolls without a reason.

### 4. End of an answer

- **Changes line (owner):** per answer. "📄 2 files changed +30 −3 · View ›" closes a turn that
  edited files, with counts from that turn's own data (`checkpointsOf`: paths and +/−). "View"
  opens today's diff sheet filtered to those paths. The composer keeps its whole-chat "files"
  pill as it is.
- **Footer:** one line in `--fs-xs` `--text-dim`: time · duration · model, then copy and ⋯ at the
  end. The ⋯ menu holds Copy as Markdown and Copy as text **only**. On a mouse the footer stays
  quiet until hover; on touch it's always there.
- **User bubble (owner):** time and ⋯. The ⋯ menu holds Copy, **Restore to before this message**
  and **Fork from here**, which is VS Code's rule and today's behaviour. Restore and Fork exist only
  here, never on an answer, because restoring truncates the chat and reverts files, so "here" must
  be unambiguous.
- **Checkpoint line (owner):** a dashed rule with a small "checkpoint" word, drawn **only after a
  turn that changed files**, where a restore matters. Tapping it opens the restore sheet for the
  next user message (the same action as that bubble's ⋯ → Restore). There's no line after the last
  turn.

### 5. Todos (new, host chats on Copilot)

- **Bridge:** for a host chat, read the session's todos and send them on the chat read as
  `todos?: {id, title, status: "pending"|"in_progress"|"done"|"blocked"}[]`, in the table's order.
  **Resolved 2026-10-24 (planning):** a host chat's `<uuid>` also has
  `~/.copilot/session-state/<uuid>/` (25 of 25 recent host chats did), and its `session.db` gets
  a `todos` table once the agent writes todos (this chat: 5 rows). So source 1 is right for host
  chats too. The notes below were the open question:
  - A Copilot CLI session keeps them in `~/.copilot/session-state/<id>/session.db`, table `todos`.
  - A host chat's id (`copilotcli:/<uuid>`) maps to `~/.vscode-server/data/agentSessionData/<uuid>/session.db`.
    That database has no `todos` table, so check whether the same `<uuid>` also has a
    session-state folder, whether the agent host protocol carries todos, or whether the SDK's
    `session.todos_changed` / `plan.readSqlTodos` is reachable from the bridge.
  - Read it read-only, and use a changed `mtime` (or the event) as the cue to read again. The
    bridge runs on the PC that owns the session.
  The signature includes the todos, so the page redraws when they change.
- **Bar above the composer** (above the pill row, in the same column):
  - **Closed:** "☑ Todos 3/7" in `--text-strong`, then the current task (the first `in_progress`,
    else the first `pending`) in `--text-dim`, ellipsized, then a caret. A 3 px bar below shows
    done/total in `--accent`.
  - **Open:** the list, one row per todo with an icon per state (✓ done, dim and struck through;
    ◐ in progress; ○ pending; ⚠ blocked in `--notice`).
  - It's hidden when there are no todos, and when every todo is done and the chat is idle.
- **In the transcript (my call):** a call to a todo tool (`manage_todo_list`, `update_todo`)
  reads as one line, "Updated todos", inside the work group. It has **no count**: the store holds
  only the current list, so a count on a past call would be wrong. A plain SQL call that touches
  `todos` stays as it is.

## Constraints

- REMOTE_BUNDLE_VERSION goes up by one (the bridge changes).
- Every new string goes through `t()` with ko/ja/zh, and the i18n test.
- The demo (`scripts/host-chats-demo-regression.ts`) gets fixtures and asserts for:
  - a folded group;
  - a subagent card: closed, open, nested;
  - a wide table that scrolls;
  - the changes line and the footer's ⋯;
  - the todo bar, closed and open.
  Each assert must fail when its feature is removed.
- DESIGN.md is updated alongside.
- Deploy the same way as ZAC-226 (deploy branch, pin, run twice, leak scan, live check).

## Base

Build on the fork's deploy branch `zhomelab` (it carries ZAC-223's marks and ZAC-226's popup and
cost), not on `main`.

## Left to the builder

- The exact live-to-folded animation (reuse `AnimatedHeight`).
- Whether pane chats get the new table and subagent look for free or keep theirs behind `style`.
- Todo source 1 versus 2, after checking the protocol.
- Icons: lucide equivalents of the mockup's glyphs.
