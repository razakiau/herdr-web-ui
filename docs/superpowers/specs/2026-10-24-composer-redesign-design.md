# Composer redesign (host chats, phone first)

**Ticket:** ZAC-207 · **Status:** draft for approval · **Mockups:** `composer-mockups.html` (direction C)

## Why

The owner's verdict on the 390 composer: "feels cheap". What drives it:

- Five pressable things of three kinds in one row (+ icon, mic icon, bordered model/agent/mode
  pills, round Send), so the eye can't tell which ones matter.
- The mic sits between attach and the pills, and Send sits apart from it at the far end. The two
  ways to send a message are split across the row.
- The mode/permissions sheet uses bordered option cards with an amber outline. That looks like a
  form, not a picker, and Mobbin's references (Claude, Notion, Codex) all use grouped inset lists.
- Attach is a bare `<input type="file">`, so Android only offers camera or the file manager. The
  chat's own folder, which is what a coding chat usually wants, isn't offered at all.

## Direction: C, hybrid (owner's pick)

Row, left to right, on every width:

```
[+]  [settings]  [◆ Opus 4.5 · High]            (ring)  [voice|send]
```

- **+**: opens the attach sheet (below).
- **Settings icon** (lucide `SlidersHorizontal`): opens the settings sheet with Permissions, Mode
  and Agent. It's `--text-dim` when every setting is default and `--notice` when Permissions is
  not Manual. That carries the shield's job from today's mode pill.
- **Model chip**: the provider mark (`ModelMarkIcon`, kept by the owner's request), the model
  name in `--text` medium, then " · effort" in `--text-dim`. No border or fill until hover or
  press (`--bg-hover`). Opens the model sheet.
- **Context ring**: today's `HostContextMeter`. On ≤480 px it moves into the toolbar too: the row
  now has room, because the pills that pushed it into the status line are gone. Shows % from 600 px.
- **Voice/Send**: one 34 px round button, always in the same spot. While the box is empty and
  dictation is available it's voice (waveform, `--text-strong` fill). As soon as there's text or
  an attachment it's Send (arrow, `--accent` fill), and a quiet mic icon appears just to its
  left. Busy chats keep today's Stop and the long-press send menu.
- On desktop (pointer: fine) the agent's name appears after the model chip when it isn't the
  default agent, so the row reads the same as VS Code's input toolbar. On a phone that name moves
  into the settings sheet.

Nothing in the row can be cut: the model name is the only word, and it ellipsizes on its own. The
demo's "no pill's words are cut at 390" assertion becomes "the model name is the only text in the
row and shows at least 8 characters at 360".

## Sheets: one shared style

All three sheets (phone) and popovers (desktop, anchored to the control, Esc closes) use grouped
inset lists:

- Group: `--bg-elevated`, `--radius-lg`, no border. Rows are 50 px minimum, with a hairline
  `--border` between rows indented past the icon.
- Row: 20 px icon in `--text-dim`, label in `--text-strong` 15 px, one explanatory line in
  `--text-dim` 12.5 px, and a `--accent` checkmark on the chosen row. No outlined cards anywhere.
- Section captions: 11 px caps, `--tracking-caps`, `--text-dim`.
- Header: title on the left, "Done" in `--accent` on the right, grab handle on top. Swipe down
  dismisses.

### Settings sheet

1. **Permissions**: Manual / Assisted / Allow all, each with today's `APPROVALS_HINT` sentence
   as its line. Allow all's icon is the shield in `--notice`.
2. **Mode**: Interactive / Plan / Autopilot, with one line each.
3. **Agent**: the default agent plus custom agents, with search from 8 agents (today's
   `AGENT_SEARCH_FROM`).

### Model sheet

- Search field first (focused on desktop, not on phone, so the keyboard doesn't cover the list).
- Effort is a segmented control (only the levels the selected model offers) under the search.
- **Pinned** and **Recent** as today (`modelProvider.ts` already stores both per machine; the
  long-press pin stays), then one group per provider under a caption. The provider tab chips go
  away: the captions and search do their job.
- Each row: provider mark, name, and the context size on the line below when the host gives it.

### Attach sheet (new)

1. **Tiles**: Camera (`capture` input) and Photos (`accept="image/*"`). A real recent-photos
   strip isn't possible from a web page: the browser gives no gallery access without a picker.
   The mockup drew one; the honest version is two tiles.
2. **Files in this folder** ›: pushes a page inside the sheet with the same search as `@`
   (`fetchHostFiles`), so the result becomes the same chip as an `@` pick.
3. **Paste from clipboard**: shown only when `navigator.clipboard.read` is permitted and holds an
   image.
4. **Upload from device**: today's file input, now last.
5. **Recent in this chat**: up to 3 paths the chat already attached or `@`-picked, each one tap.

Desktop: + opens the same content as a popover; drag-and-drop and paste stay as they are.

## Out of scope

- The chat reader (tool calls, colours, turns). That's round 2, with its own audit and doc.
- Pane (terminal) chats' composer: it shares `Composer`, but its row (status pill) stays as it
  is. The new row is host-chat only, behind the existing `pills` / `toolbarEnd` props plus a new
  `settings` slot.
- New keyboard shortcuts.

## Testing

- Unit: the voice/send state (empty, text, attachment only, dictation unavailable, busy) and
  the settings icon's tone.
- host-chats demo (390 and 1440): the row order, the model mark present in the chip, the
  settings icon in `--notice` when Allow all is on, voice turning into send on the first
  character, each sheet's checkmark on the current value, the attach sheet's folder search
  producing a chip, and no overflow at 360, 390 and 1440.
- composer-fit, restored-draft and android-ime demos stay green.
- Live check on the owner's phone after deploy.

## Rejected

- **A, quiet row** (all settings as words): the row overflows at 360 with a long model name plus
  a custom agent. It brings back today's cut-words problem.
- **B, one chip**: a model change, the most frequent one, takes two taps.
