import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type AnswerStep, findLastIndex, finishPrompt, isDivider, KEY, keySteps, navigationKeys, onePerPass, type ParsedPrompt } from "./shared.ts";

/**
 * Copilot CLI's ask_user form (1.0.88), one field of an elicitation schema:
 *
 *   Copilot needs information.
 *   Pick a colour?
 *
 *   Colour:
 *   ❯ Red
 *     Blue
 *     Other (type your answer)
 *
 *   ↑/↓ select · enter accept · ctrl+d decline · esc cancel
 *
 * The cursor on Other turns its row into "Other (type your answer below)" and opens the input box
 * under the form, "❯ Type your answer..." until something is typed there; the text goes there,
 * after ctrl+k and ctrl+u empty it of anything typed in the terminal. A field with no choices is
 * a single `❯` line between two rules, emptied the same way. A form of several fields shows a tab
 * row (`[Colour]  Proceed`, the open field in brackets): Enter on a field moves to the next one,
 * and on the last one sends the form (measured on 1.0.88), so each field is a card of its own.
 */
export const COPILOT_ASK_HINT_RE = /^(?:↑\/↓ select · )?enter accept · (?:(?:shift\+)?tab (?:next|prev) · )*ctrl\+d decline · esc cancel$/;
const COPILOT_ASK_TITLE = "Copilot needs information.";
const COPILOT_OTHER_RE = /^Other \(type your answer(?: below)?\)$/;
/** a form's row of fields, the open one in brackets: `[Colour]  Proceed` */
const COPILOT_TABS_RE = /^(?:\[[^\]]+\]|[^\s[\]][^[\]]*?)(?:\s{2,}(?:\[[^\]]+\]|[^\s[\]][^[\]]*?))+$/;
/** what is on Copilot's input line is emptied on both sides of the cursor before an answer is typed */
const copilotTyped = (text: string): AnswerStep[] => [...keySteps(["ctrl+k", "ctrl+u"]), { text }, ...keySteps([KEY.enter])];

function parseCopilotAsk(screen: string): ParsedPrompt | null {
  const raw = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const lines = raw.map((line) => line.trim());
  // a phone-width pane wraps the hint over up to three lines: where the wrapped hint begins
  // the wrapped lines are the ones right under it: a blank line or a rule ends the hint (the open Other
  // line's input box comes after a rule, and must never be read as the hint's tail)
  const hintSpan = (index: number) => {
    for (let span = 1; span <= 3; span += 1) {
      const part = lines.slice(index, index + span);
      if (part.some((line) => !line || isDivider(line))) return undefined;
      if (COPILOT_ASK_HINT_RE.test(part.join(" "))) return span;
    }
    return undefined;
  };
  const hintIndex = findLastIndex(lines, (_, index) => hintSpan(index) !== undefined);
  if (hintIndex < 0) return null;
  const hintText = lines.slice(hintIndex, hintIndex + hintSpan(hintIndex)!).join(" ");
  const titleIndex = findLastIndex(lines.slice(0, hintIndex), (line) => line === COPILOT_ASK_TITLE);
  if (titleIndex < 0) return null;
  // a paragraph a narrow pane wraps goes on, at the same indent, on the next line: a blank line, a change
  // of indent, a line that ends a sentence or a title's colon end it. Its lines are one line of text again,
  // as a wide pane drew them. Only above the rows: once a row (or the `❯` line) shows, every line is its own
  const kept: { line: string; indent: number }[] = [];
  let joinable = false;
  let inRows = false;
  for (const rawLine of raw.slice(titleIndex + 1, hintIndex)) {
    const line = rawLine.trim();
    if (!line || isDivider(line)) { joinable = false; continue; }
    const indent = rawLine.length - rawLine.trimStart().length;
    const previous = kept.at(-1);
    inRows ||= /^❯(?:\s|$)/.test(line) || (previous !== undefined && indent > kept[0]!.indent);
    if (!inRows && joinable && previous && previous.indent === indent && !/[:.!?]$/.test(previous.line)) previous.line += ` ${line}`;
    else kept.push({ line, indent });
    joinable = true;
  }
  const block = kept.map(({ line }) => line);
  // The question (the message, which can take several lines: a heading and a paragraph, 1.0.88), a
  // form's row of fields, the field's title, a description when the schema gives one, then the
  // field's rows or its `❯` line. Copilot indents a row under the cursor's mark: "❯ Red" or "  Green",
  // two columns in from the text above, so the first line that is a row, or the `❯` line, ends what
  // is text; the title is the last text line, or the one before it when that one is the description
  const indent = kept[0]?.indent ?? 0;
  const tabbed = /\b(?:shift\+)?tab (?:next|prev)\b/.test(hintText);
  // a form's row of fields is indented too when its first field is not the open one ("  Colour  [Proceed]")
  const isTabs = (line: string) => tabbed && COPILOT_TABS_RE.test(line) && /\[[^\]]+\]/.test(line);
  const firstRow = kept.findIndex(({ line, indent: at }) => /^❯(?:\s|$)/.test(line) || (at > indent && !isTabs(line)));
  if (firstRow < 0) return null;
  const tabsAt = tabbed ? block.findIndex((line, index) => index > 0 && index < firstRow && isTabs(line)) : -1;
  if (tabbed && tabsAt < 0) return null;
  // two text lines after the question (or the row of fields): the title and its description. One: the title
  const after = tabbed ? tabsAt + 1 : -1;
  const textLines = firstRow - (tabbed ? after : 1);
  const titleAt = tabbed ? after : firstRow - (textLines >= 2 && /:$/.test(block[firstRow - 2]!) ? 2 : 1);
  if (titleAt < 1 || titleAt >= firstRow || (tabbed && firstRow - after > 2)) return null;
  const question = block.slice(0, tabbed ? tabsAt : titleAt).join("\n");
  const tabs = tabbed ? block[tabsAt] : undefined;
  const names = tabs?.split(/\s{2,}/) ?? [];
  const fields = names.map((name) => name.replace(/^\[(.*)\]$/, "$1"));
  const open = names.findIndex((name) => /^\[.*\]$/.test(name));
  if (tabbed && open < 0) return null;
  // a choice field's title ends in a colon, a free-text field's does not ("Notes (optional)")
  const field = block[titleAt]?.replace(/:$/, "");
  if (!question || field === undefined || (tabbed && fields[open] !== field)) return null;
  // the line between the title and the rows, when the field's schema has a description (1.0.88)
  const description = firstRow - titleAt === 2 ? block[titleAt + 1]! : null;
  const rest = block.slice(firstRow);
  // where the form stands: part of the id, so each field is a card of its own
  const position = tabbed ? `Field ${open + 1} of ${fields.length}: ${fields.join(", ")}` : null;
  const body = [description, position].filter((part) => part !== null).join("\n") || null;
  // free text: one `❯` line between the field's rules, empty or holding what was typed in the terminal
  if (rest.length === 1 && /^❯(?:\s|$)/.test(rest[0]!)) {
    // Enter on an empty line passes the field (the next one opens, or the form is sent): a field whose title
    // says it is optional gets that as a choice of its own, so a card that wants no answer can be left
    const optional = /\boptional\b/i.test(field);
    const typedIndex = optional ? 1 : 0;
    return finishPrompt("copilot", {
      kind: "question", title: field, question, body,
      options: [...(optional ? [{ label: "Leave empty", description: null }] : []), { label: "Type your answer", description: null }],
      multi_select: false, custom_option_index: typedIndex,
    }, { responder: "copilot-input", menuLabels: [], selectedIndex: typedIndex, checkedOptionIndices: [], customMenuIndex: typedIndex, rejectWithEscapeIndex: null,
      customSteps: copilotTyped,
      // the typed option's slot is never read (an option_index there is refused): only Leave empty has steps
      ...(optional ? { optionSteps: [keySteps(["ctrl+k", "ctrl+u", KEY.enter]), []] } : {}) });
  }
  const rows: { label: string; selected: boolean }[] = [];
  for (const line of rest) {
    const row = line.match(/^(❯\s+)?(\S.*)$/);
    if (row === null) return null;
    rows.push({ label: row[2]!, selected: row[1] !== undefined });
  }
  if (rows.length < 2 || !COPILOT_OTHER_RE.test(rows.at(-1)!.label)) return null;
  // Other's line is the input box under the form: it must be there, whatever was typed on it
  if (rows.at(-1)!.selected && !lines.slice(hintIndex + 1).some((line) => /^❯(?:\s|$)/.test(line))) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (selectedIndex < 0 || rows.filter((row) => row.selected).length !== 1) return null;
  const choices = rows.slice(0, -1);
  const other = choices.length;
  return finishPrompt("copilot", {
    kind: "question", title: field, question, body,
    options: choices.map((row) => ({ label: row.label, description: null })),
    multi_select: false, custom_option_index: other,
  }, {
    responder: "copilot-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: [], customMenuIndex: other, rejectWithEscapeIndex: null,
    // reaching Other opens its line: the text is typed there, and Enter sends it
    customSteps: (text) => [...keySteps(navigationKeys(other - selectedIndex)), ...copilotTyped(text)],
  });
}

const askRead = onePerPass((screen) => parseCopilotAsk(screen));

export const readers: readonly DialogReader[] = [
  {
    id: "copilot-question", agents: ["copilot"], priority: 10,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = askRead(screen, ctx);
      return parsed?.responder === "copilot-question" ? parsed : null;
    },
  },
  {
    id: "copilot-input", agents: ["copilot"], priority: 10,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = askRead(screen, ctx);
      return parsed?.responder === "copilot-input" ? parsed : null;
    },
  },
];
