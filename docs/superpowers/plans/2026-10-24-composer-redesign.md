# Composer redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give host chats the direction-C composer: `+ · settings · [mark model · effort] · ring · voice/Send`, grouped-list sheets, and an attach sheet that offers the chat's folder.

**Architecture:** The pure decisions (which round button shows, which tone the settings icon has) go into `src/lib/compose.ts` with unit tests. `Composer` gains a `settings` slot and an `attachMenu` hook; when `attachMenu` is set, `+` calls it instead of clicking the file input. `HostChatView` replaces the three pills with a settings button and the model chip, and opens `ModelPicker` with `focus: "model" | "settings"` or the new `AttachSheet`. Pane chats are unchanged.

**Tech Stack:** React 19 + TypeScript, Bun test, Playwright demos under `scripts/`, lucide-react icons, CSS with DESIGN.md tokens.

**Spec:** `docs/superpowers/specs/2026-10-24-composer-redesign-design.md`

## Global Constraints

- Tokens only: `--bg-elevated`, `--bg-hover`, `--border`, `--text`, `--text-dim`, `--text-strong`, `--accent`, `--notice`, `--radius-lg`, `--tracking-caps`. No new colours.
- The model chip keeps `ModelMarkIcon` (owner's request).
- The round button is 34 px. Voice: lucide `AudioLines`, `--text-strong` fill. Send: `ArrowUp`, `--accent` fill.
- The settings icon is lucide `SlidersHorizontal`: `--text-dim` when approvals are `default` or unknown, `--notice` otherwise.
- Sheet rows are at least 50 px; captions are 11 px caps in `--text-dim`; the chosen row has an `--accent` `Check`; no bordered option cards.
- The pane-chat composer (no `pills` prop) renders exactly as today.
- New user-facing strings get ja/ko/zh entries in `src/lib/i18n.{ja,ko,zh}.ts`.
- DESIGN.md's composer section (~1503) is updated in the same task that changes the look.

## Review Focus

1. **Dictation unavailable** (no mic permission, http origin): the round button is Send (disabled while empty), never a dead voice button. Covered by Task 1's unit test.
2. **Busy chat with an empty box**: Stop still shows where voice/Send sits. Covered by Task 1 (`roundButton` returns `"stop"`).
3. **Long model name plus a custom agent at 360 px**: no row overflow, and the name ellipsizes while showing at least 8 characters. Covered by Task 2's demo step.
4. **Host with no approval modes** (`config.approvalModes` empty): the settings sheet shows Mode and Agent only, and the icon stays quiet. Covered by Task 3's demo step.
5. **Attach-only message** (a chip, no text): the round button is Send and enabled. Covered by Task 1's unit test and Task 4's demo step.

---

### Task 1: Round-button and settings-tone decisions

**Files:**
- Modify: `src/lib/compose.ts` (next to `composerSendShown`, ~182)
- Test: `src/lib/compose.test.ts`

**Interfaces:**
- Produces: `roundButton(state: { working: boolean; text: string; attachments: number; voice: boolean }): "stop" | "voice" | "send"` and `settingsTone(approvals: string | null | undefined): "quiet" | "raised"`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("roundButton", () => {
  it("is voice on an empty idle box when dictation is there", () => {
    expect(roundButton({ working: false, text: "", attachments: 0, voice: true })).toBe("voice");
  });
  it("is send as soon as there is text or an attachment", () => {
    expect(roundButton({ working: false, text: "a", attachments: 0, voice: true })).toBe("send");
    expect(roundButton({ working: false, text: "  ", attachments: 1, voice: true })).toBe("send");
  });
  it("is send, never a dead voice button, without dictation", () => {
    expect(roundButton({ working: false, text: "", attachments: 0, voice: false })).toBe("send");
  });
  it("is stop on a busy chat with nothing typed, send once something is", () => {
    expect(roundButton({ working: true, text: "", attachments: 0, voice: true })).toBe("stop");
    expect(roundButton({ working: true, text: "steer", attachments: 0, voice: true })).toBe("send");
  });
});
describe("settingsTone", () => {
  it("is raised only for a non-default level", () => {
    expect(settingsTone("autoApprove")).toBe("raised");
    expect(settingsTone("assisted")).toBe("raised");
    expect(settingsTone("default")).toBe("quiet");
    expect(settingsTone(null)).toBe("quiet");
    expect(settingsTone(undefined)).toBe("quiet");
  });
});
```

- [ ] **Step 2: Run** `bun test src/lib/compose.test.ts`. Expected: FAIL, `roundButton` is not exported.

- [ ] **Step 3: Implement both in `src/lib/compose.ts`.** `roundButton`: has content = `text.trim() !== "" || attachments > 0`; working with no content → `"stop"`; no content and `voice` → `"voice"`; otherwise `"send"`.

- [ ] **Step 4: Run** `bun test src/lib/compose.test.ts`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(composer): decide the round button and the settings tone`

### Task 2: The new row (host chats only)

**Files:**
- Modify: `src/components/Composer.tsx` (props ~139-143; left controls ~1385-1410; right controls ~1470-1515)
- Modify: `src/components/Composer.css` (`.composer-action` block ~455-680)
- Modify: `src/components/HostChatView.tsx` (pills ~271-305; Composer props ~336-345)
- Modify: `src/components/HostChatView.css` (top ~110 lines: pill rules, `@container pickers`)
- Modify: `src/components/HostChatStatus.tsx` (phone placement of `HostContextMeter`)
- Modify: `DESIGN.md` (composer ~1503, Stop ~1554)
- Test: `scripts/host-chats-demo-regression.ts` (~1270-1280, and the 1440 pass near the end)

**Interfaces:**
- Consumes: `roundButton`, `settingsTone` (Task 1).
- Produces: `ComposerProps.settings?: ReactNode`, drawn right after `+`. The `pills` slot holds only the model chip (class `host-chat-model`), plus `.host-chat-agent-name` on `pointer: fine` when an agent is picked. The settings button: class `host-chat-settings`, `data-tone="quiet|raised"`, `aria-label` "Chat settings: {0}, {1}, {2}" (mode, permissions, agent). The round button keeps `composer-send` / `composer-stop`; voice is `.composer-action.composer-voice`.

- [ ] **Step 1: Replace the "no pill's words are cut" block (~1270) with failing assertions**

```ts
const order = await view.locator(".composer-controls-left > *, .composer-controls-right > *").evaluateAll((nodes) =>
  nodes.filter((n) => (n as HTMLElement).offsetParent !== null)
    .map((n) => n.className.toString().match(/composer-attach|host-chat-settings|composer-pickers|host-context-meter|composer-voice|composer-send|composer-stop/)?.[0])
    .filter(Boolean));
assert.deepEqual(order, ["composer-attach", "host-chat-settings", "composer-pickers", "host-context-meter", "composer-voice"], "the row reads + · settings · model · ring · voice on an empty box");
assert.equal(await view.locator(".host-chat-model .agent-mark, .host-chat-model .model-mark-sparkle").count(), 1, "the model chip keeps its provider mark");
assert.equal(await view.locator(".host-chat-agent, .host-chat-mode").count(), 0, "agent and mode pills are gone");
await box.fill("x");
await view.locator(".composer-send").waitFor();
assert.equal(await view.locator(".composer-voice").count(), 0, "voice becomes send on the first character");
await view.locator(".composer-controls-right .voice-mic-wrap").waitFor();
await box.fill("");
```

At 360 px (set the viewport, check, then restore 390), with the fixture's longest model and a custom agent picked:

```ts
assert.ok(await view.locator(".composer-surface").evaluate((n) => n.scrollWidth <= n.clientWidth + 1), "nothing overflows at 360");
const shownChars = await view.locator(".host-chat-model .host-chat-pill-label").evaluate((n) => {
  const full = n.textContent ?? ""; const per = n.scrollWidth / Math.max(1, full.length); return Math.floor(n.clientWidth / per);
});
assert.ok(shownChars >= 8, `the model name shows at least 8 characters at 360 (${shownChars})`);
```

In the 1440 pass, with a custom agent picked: `.host-chat-agent-name` is visible, and the `.host-context-meter` text matches `/\d+%/`.

- [ ] **Step 2: Run** `perl -e 'alarm 600; exec @ARGV' bun scripts/host-chats-demo-regression.ts`. Expected: FAIL at "the row reads + · settings · model · ring · voice".

- [ ] **Step 3: Implement**
  - `Composer`: render `settings` after attach. Compute `roundButton({ working: isWorking, text, attachments: attachments.length, voice: dictation.shown })`. When it's `"send"` and `dictation.shown`, render `<MicButton>` just before Send on the right. The left `MicButton` renders only when `pills === undefined`.
  - The voice button gets `MicButton`'s press handling: extract its pointer and click handlers into a `useMicPress(dictation)` hook in `VoiceInput.tsx` and use it in both, so a hold dictates the same way.
  - `HostChatView`: remove the agent and mode pill buttons; add the settings button (`icon-button host-chat-settings`, `SlidersHorizontal`), which opens `openSheet("mode")` until Task 3 renames it. The model chip loses its border and `ChevronDown`.
  - `HostChatStatus`: the meter always goes in `toolbarEnd`; delete the ≤480 `data-place="status"` branch and its CSS.
  - CSS: `.host-chat-settings[data-tone="raised"] { color: var(--notice) }`; `.composer-voice { background: var(--text-strong); color: var(--bg) }`; chip `:hover`/`:active` background `--bg-hover`; delete the `@container pickers` rules that dropped words.
  - DESIGN.md: rewrite the composer-row paragraph to match the spec's "Direction" section.

- [ ] **Step 4: Run** the host-chats demo (all PASS), `bun scripts/composer-fit-demo-regression.ts` (22 PASS), `bun scripts/android-ime-regression.ts`, `bun run typecheck`.

- [ ] **Step 5: Commit** `feat(composer): one quiet row for host chats: settings, model, voice/send`

### Task 3: Grouped-list sheets (settings and model)

**Files:**
- Modify: `src/components/ModelPicker.tsx` (`focus` type; `ModeList` + `AgentList` → `SettingsList`; `ModelList` tabs ~126-135)
- Modify: the CSS holding `.host-picker-*` (grep `host-picker-option`)
- Modify: `src/components/HostChatView.tsx` (`sheet` state type ~113, `openSheet`, settings button target)
- Modify: `src/lib/i18n.{ja,ko,zh}.ts`, `DESIGN.md`
- Test: `scripts/host-chats-demo-regression.ts` (the existing mode/agent sheet steps)

**Interfaces:**
- Consumes: `.host-chat-settings` (Task 2).
- Produces: `ModelPickerProps.focus: "model" | "settings"` (`"agent"` and `"mode"` removed). Settings sheet: title "Chat settings", sections Permissions, Mode, Agent. An option is `.host-picker-option` containing `.host-picker-option-icon`, `.host-picker-option-name`, `.host-picker-option-id` and a `Check` when picked.

- [ ] **Step 1: Point the demo's agent and mode sheet steps at `.host-chat-settings` and add**

```ts
const sheet = page.locator('.host-picker[data-picker="settings"]');
assert.deepEqual(await sheet.locator(".host-picker-provider").allTextContents(), ["Permissions", "Mode", "Agent"]);
assert.equal(await sheet.locator('.host-picker-option[data-approvals="autoApprove"] .host-picker-option-id').textContent(), "Copilot runs all tools without asking for approval.");
assert.equal(await sheet.locator(".host-picker-option.is-picked .host-picker-check").count(), 3, "one checkmark per section");
assert.equal(await sheet.locator(".host-picker-option").first().evaluate((n) => getComputedStyle(n).borderTopWidth), "0px", "no outlined cards");
assert.ok(await sheet.locator(".host-picker-option").first().evaluate((n) => n.getBoundingClientRect().height >= 50), "rows are at least 50 px");
```

Then a fixture with `approvalModes: []`: the sections are `["Mode", "Agent"]` and `.host-chat-settings` has `data-tone="quiet"`. On the model sheet: `.host-picker-tabs` count is 0, the captions include "Recent", and the existing pin and effort steps still pass.

- [ ] **Step 2: Run** the demo. Expected: FAIL, `data-picker="settings"` not found.

- [ ] **Step 3: Implement**
  - `SettingsList({ config, agents, agent, onConfig, onAgent })`: Permissions first, with each `APPROVALS_HINT` as the line. Icons: `Hand` (default), `Scale` (assisted), `ShieldCheck` in `--notice` (autoApprove). Mode rows use `MessageSquare` / `ListChecks` / `Rocket` with the lines "Asks and answers as you go", "Plans before it changes anything", "Works through the task on its own". The Agent section keeps the search from `AGENT_SEARCH_FROM` and its note. A section with no values is omitted.
  - Model sheet: remove the provider tabs and the `tab` state (`filterModels(models, query, null)`). Under the search, add an effort segmented control for the picked model (`.host-picker-segment`, buttons with `aria-pressed`, only that model's `efforts.values`); keep the per-row effort chips for other rows.
  - CSS: `.host-picker-group { background: var(--bg-elevated); border-radius: var(--radius-lg) }`; options have no border, `min-height: 50px`, and an inset hairline through `.host-picker-option + .host-picker-option::before`; captions per Global Constraints.
  - i18n: "Chat settings", the three mode lines, and "Chat settings: {0}, {1}, {2}".

- [ ] **Step 4: Run** the host-chats demo, `bun run test:unit` (only the known install-star failure), `bun run typecheck`.

- [ ] **Step 5: Commit** `feat(composer): settings and model sheets as grouped lists`

### Task 4: Attach sheet

**Files:**
- Create: `src/components/AttachSheet.tsx`, `src/components/AttachSheet.css`
- Modify: `src/components/Composer.tsx` (attach `onClick`; the `attachMenu` api)
- Modify: `src/components/HostChatView.tsx` (pass `attachMenu`, render `AttachSheet`)
- Modify: `src/lib/i18n.{ja,ko,zh}.ts`, `DESIGN.md`
- Test: `scripts/host-chats-demo-regression.ts` (block 4b ~1028)

**Interfaces:**
- Consumes: `fetchHostFiles(machineId, session, query)`; the composer's `@`-pick chip (`picked: true`).
- Produces:
  - `ComposerProps.attachMenu?: (api: AttachApi) => void`, with `AttachApi = { pickFiles(opts?: { accept?: string; capture?: boolean }): void; addPicked(path: string): void; addFile(file: File): void }`, exported from `Composer.tsx`.
  - `AttachSheet` props: `{ machineId: string; session: string; recent: string[]; api: AttachApi; onClose(): void }`. `recent` is the chat's last 3 distinct attachment paths from user turns, newest first.

- [ ] **Step 1: Write the failing demo steps** (start of block 4b, before the PNG upload)

```ts
await view.locator(".composer-attach").click();
const attach = page.locator(".attach-sheet");
assert.deepEqual(await attach.locator(".attach-tile").allTextContents(), ["Camera", "Photos"]);
await attach.getByRole("button", { name: "Files in this folder" }).click();
await attach.locator('input[type="search"]').fill("READ");
await attach.getByText("README.md").click();
await page.waitForFunction(() => document.querySelectorAll(".composer-attachments .composer-attachment").length === 1);
assert.equal(await view.locator(".composer-send").isEnabled(), true, "a chip alone can be sent");
await view.locator(".composer-attachment").getByRole("button", { name: /Remove/ }).click();
```

After 4b's send, open the sheet again: "Recent in this chat" lists `README.md`. "Upload from device" fires `page.waitForEvent("filechooser")` with `isMultiple()` true; "Photos" fires one whose element's `accept` is `image/*`.

- [ ] **Step 2: Run** the demo. Expected: FAIL, `.attach-sheet` not found.

- [ ] **Step 3: Implement**
  - `AttachSheet`: the same shell as `ModelPicker` (portal, `useFocusTrap`, `useSheetSwipe`, `usePhoneSheetBack`, Esc). The tiles call `api.pickFiles({ accept: "image/*", capture: true })` and `api.pickFiles({ accept: "image/*" })`. "Files in this folder" pushes an inner page with search and results (150 ms debounce), and a pick calls `api.addPicked(path)` and closes. "Paste from clipboard" shows only when `navigator.clipboard?.read` exists; it reads the first `image/*` item into `api.addFile`. "Upload from device" calls `api.pickFiles()`. On `(pointer: fine)` it renders as a popover anchored above `+` instead of a sheet.
  - `Composer`: when `attachMenu` is set, `+` calls it with the api. `pickFiles` sets `accept`/`capture` on the hidden input, clicks it, and clears them on change. `addPicked` reuses the `@` branch of `selectCompletion` (extract it into a function). `addFile` goes through `uploadImages([file])`.
  - Strings: "Add to chat", "Camera", "Photos", "Files in this folder", "Paste from clipboard", "Upload from device", "Recent in this chat".

- [ ] **Step 4: Run** the host-chats demo, composer-fit, restored-draft, typecheck.

- [ ] **Step 5: Commit** `feat(composer): an attach sheet that offers the chat's folder first`

### Task 5: Ship

- [ ] One fork PR with this branch plus PR #10's commit (bare `@`); merge into main. Cherry-pick onto fork `zhomelab` (lease `164b116851b5833af7128f364c11983f2c484145`); there, run typecheck and the host-chats demo.
- [ ] zhomelab worktree: bump `herdr_web_commit`; check, apply, re-run (changed=3, then 0); leak scan.
- [ ] Live crawl at 390 and 1440: the row order, both sheets, and the attach sheet's folder search producing a chip.
- [ ] Update `.handoffs/herder-ui-web.md`.
