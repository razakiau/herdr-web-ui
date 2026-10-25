import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, Maximize2, Minimize2, Plus, Send, X } from "lucide-react";

import "./PromptCard.css";

import { ApiError, assertAttachable } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { customAnswerWithFiles, focusFollowsAnswer, pressOrigin, recommendedLabel, type TypedAnswer } from "../lib/promptAnswer.ts";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { Markdown } from "./Markdown.tsx";
import { AttachSheet } from "./AttachSheet.tsx";
import "./AttachSheet.css";

/**
 * One card is one occurrence of a prompt on one pane: its owner mounts a new card (a `key`) for
 * the next prompt, the same question asked again included. So the card's picks, text, scroll and
 * an answer still on its way never pass to another prompt, and an answer that comes back after
 * the card is gone reports nothing.
 */
export interface PromptCardProps {
  paneId: string;
  prompt: InteractivePrompt;
  onPromptChanged(): void;
  /** the answer went out; `toMessageBox`: the keyboard's focus was in the card, which is about to go, nothing else has taken it since, and the press was a key or a mouse, not a tap */
  onAnswered(toMessageBox: boolean): void;
  /** an option picked by a typed message, sent only on Confirm */
  typedAnswer?: TypedAnswer | null;
  onTypedAnswerDone?(): void;
  /**
   * A Copilot prompt (a host chat's, or a `copilot` pane's): its title, question and message are
   * Markdown, as VS Code draws them. Off for every other agent: their cards read as plain text.
   */
  markdown?: boolean;
  /**
   * A Copilot card's typed answer takes files (VS Code's answer field has the composer's attach
   * and mic): each is stored with this, and its path leads the answer as `@path`. Absent: no
   * attach button, as every other agent's card.
   */
  onUploadFile?: (file: File) => Promise<string>;
  /** a Copilot card opens to a full-height sheet and back, keeping its step, picks and text */
  expandable?: boolean;
  /** the last reads of the screen failed: the question shown may have changed since (an answer is still checked, 409 prompt_changed) */
  stale?: boolean;
}

export function PromptCard({ paneId, ...props }: PromptCardProps) {
  const { answerPanePrompt } = useMachineApi();
  const submit = async (choice: PromptChoice): Promise<void> => {
    await answerPanePrompt({ pane_id: paneId, prompt_id: props.prompt.id, ...choice });
  };
  return <PromptCardView {...props} submit={submit} />;
}

/**
 * A Copilot card's typed-answer slot names the field: the bridge sends it in English
 * (server/agent-host/chats.ts OTHER_LABEL / ANSWER_LABEL), so the card says it in the user's language.
 */
function copilotSlot(label: string | undefined, t: Translate): string {
  if (label === "Other…") return t("Other…");
  if (label === "Answer") return t("Answer");
  return label ?? t("Type an answer");
}

/** One answer as the card gives it: an option, several, or typed words. */
export type PromptChoice = Omit<PromptAnswer, "pane_id" | "prompt_id"> & {
  /** a Copilot form answered whole, one entry per question: null for an optional one left empty */
  form?: ({ option_indices: number[]; custom_text?: string } | null)[];
};

/** One page of a form as the card keeps it until Submit: the picks, the typed words, their files. */
/** a file in the answer field: one from the device (uploaded on send), or one of the chat's folder (sent as its `@path`) */
type AnswerFile = { id: number; file: File; preview: string } | { id: number; path: string; preview: "" };
const fileName = (each: AnswerFile): string => "file" in each ? each.file.name : each.path.split("/").pop() || each.path;
/** the answer's text with every file leading it as `@path`: device files uploaded first (a failure stops the lot) */
async function withFiles(text: string, files: readonly AnswerFile[], upload: (file: File) => Promise<string>, done: (text: string) => Promise<void>): Promise<{ ok: true } | { ok: false; error: string }> {
  const folder = files.flatMap((each) => "path" in each ? [`@${each.path}`] : []);
  const device = files.flatMap((each) => "file" in each ? [each.file] : []);
  return customAnswerWithFiles(text, device, upload, async (uploaded) => { await done([...folder, uploaded].filter((part) => part.trim() !== "").join(" ")); });
}
interface FormDraft { selected: number[]; custom: string; files: AnswerFile[] }
const draftAnswered = (draft: FormDraft): boolean => draft.selected.length > 0 || draft.custom.trim() !== "" || draft.files.length > 0;

/**
 * The card itself, with whatever sends its answer: a pane's answers go to its prompt route
 * (PromptCard), a host chat's to its host (HostChatView). `submit` rejects with the route's
 * ApiError; a 409 `prompt_changed` (or 400 `invalid_answer`) says the card was stale.
 */
export interface PromptCardViewProps extends Omit<PromptCardProps, "paneId"> {
  submit(choice: PromptChoice): Promise<void>;
  /** a host chat's card: + opens the composer's attach sheet (its folder, camera, photos) for this chat */
  attachSheet?: { machineId: string; session: string };
}

export function PromptCardView({ prompt, submit, onPromptChanged, onAnswered, typedAnswer = null, onTypedAnswerDone, markdown = false, onUploadFile, expandable = false, attachSheet, stale = false }: PromptCardViewProps) {
  const t = useT();
  // the agent's own defaults (an OpenCode field restored by Back) stand picked and typed from the start
  const [selected, setSelected] = useState<Set<number>>(() => {
    if (prompt.default_option_indices && prompt.default_option_indices.length > 0) return new Set(prompt.default_option_indices);
    if (prompt.default_option_index !== undefined && prompt.default_option_index !== null) return new Set([prompt.default_option_index]);
    return new Set();
  });
  const [custom, setCustom] = useState(() => prompt.default_custom_text ?? "");
  // a Copilot answer's files, as thumbnails in the field until it is sent
  const [files, setFiles] = useState<AnswerFile[]>([]);
  // the composer's attach sheet, open over the card (ZAC-207: the card's + was a bare device picker)
  const [attachOpen, setAttachOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  // folded to its header, to read the transcript under it; the question still waits, so the card
  // stays. A typed answer to confirm opens it, and the next prompt's card starts open
  const [foldedByUser, setFoldedByUser] = useState(false);
  const folded = foldedByUser && typedAnswer?.option_index === undefined;
  const cardRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // the control Enter or Space last went down on: the click that follows on it is that key's
  const keyed = useRef<EventTarget | null>(null);
  // and the button a pointer last went down on, with what it was: a click can misname its pointer
  const down = useRef<{ target: EventTarget; pointerType: string } | null>(null);
  // false once the card is gone: its prompt was replaced, or its pane left
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);

  // the question to confirm stays on the card's fold (PromptCard.css); a card scrolled past it
  // comes back to it, and nothing outside the card moves
  useEffect(() => {
    confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [typedAnswer]);

  // The card stands where the transcript was on a short phone: a tap on its text, or a drag down
  // it once it is at its top, puts the keyboard away as on the transcript (lib/keyboard.ts).
  // Its buttons, boxes and field do what they do.
  useEffect(() => {
    const node = cardRef.current;
    return node === null ? undefined : dismissKeyboardOn(node, { atTopOnly: true });
  }, [expanded]);

  /**
   * Sends one answer. `press` is the click that asked for it (none for a key in the card's field).
   * Resolves to whether this card is still the one shown: an answer that comes back after another
   * prompt took its place, or after its pane was left, changes nothing there.
   */
  // whether the last answer went: `answer` itself says only whether the card is still the one shown
  const answeredOk = useRef(false);
  const answer = async (choice: PromptChoice, press?: { nativeEvent: Event; currentTarget: EventTarget }): Promise<boolean> => {
    // Native OpenCode multiselect fields accept checks and a custom entry in the same array.
    // Both buttons and Enter submit the whole field, including edits restored by Back.
    if (prompt.agent === "opencode" && !prompt.fallback && prompt.multi_select && (choice.option_indices !== undefined || choice.custom_text !== undefined)) {
      choice = {
        option_indices: [...selected].sort((a, b) => a - b),
        ...(custom.trim() ? { custom_text: custom.trim() } : {}),
      };
    }
    // read now: the pressed button is disabled while the answer is on its way, and loses the focus
    const fromCard = cardRef.current?.contains(document.activeElement) === true;
    const click = press?.nativeEvent as Partial<PointerEvent> | undefined;
    const origin = pressOrigin(press === undefined ? undefined : { pointerType: click?.pointerType, downType: down.current?.target === press.currentTarget ? down.current.pointerType : undefined, detail: click?.detail, keyed: keyed.current === press.currentTarget });
    keyed.current = null;
    down.current = null;
    // the device's own pointer, asked only for a press that does not say what made it
    const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
    setPending(true);
    setError(null);
    answeredOk.current = false;
    try {
      await submit(choice);
      answeredOk.current = true;
      if (!shown.current) return false;
      // answered from the full-height sheet: back to the chat, as the inline card would be
      setExpanded(false);
      // and read again: the answer took a moment, and the user may have gone on to something else
      const card = cardRef.current;
      const active = document.activeElement;
      onAnswered(focusFollowsAnswer({ fromCard, origin, coarse, cardMounted: card !== null, inCard: card?.contains(active) === true, onPage: active === null || active === document.body }));
    } catch (cause) {
      if (!shown.current) return false;
      // a card read before the question moved on: refused as changed (409), or as an answer it no longer fits (400).
      // The note stays until the card is replaced or answered again, so the button never looks dead
      if (cause instanceof ApiError && cause.code === "reply_unconfirmed") {
        setError({ message: t("OpenCode did not confirm the answer. Check the question before sending again."), detail: null });
        onPromptChanged();
      } else if (cause instanceof ApiError && ((cause.status === 409 && cause.code === "prompt_changed") || (cause.status === 400 && cause.code === "invalid_answer"))) {
        setError({ message: t("The question on screen changed; check it and answer again."), detail: null });
        onPromptChanged();
      } else {
        setError(userErrorMessage(cause));
      }
    }
    setPending(false);
    return true;
  };

  // the typed answer: with files, each goes up first and leads the text as `@path`; a failed
  // upload says why and posts nothing, and the card keeps its text and files
  const answerCustom = async (press?: { nativeEvent: Event; currentTarget: EventTarget }): Promise<void> => {
    const text = custom.trim();
    if (files.length === 0 || !onUploadFile) {
      await answer({ custom_text: text }, press);
      return;
    }
    setPending(true);
    setError(null);
    const result = await withFiles(text, files, onUploadFile, async (withPaths) => { await answer({ custom_text: withPaths }, press); });
    if (!shown.current) return;
    if (!result.ok) { setError({ message: result.error, detail: null }); setPending(false); }
  };
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => { for (const each of filesRef.current) if (each.preview) URL.revokeObjectURL(each.preview); }, []);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const addFiles = (picked: readonly File[]): void => {
    const kept: AnswerFile[] = [];
    for (const file of picked) {
      try { assertAttachable(file); } catch (cause) { setError(userErrorMessage(cause)); continue; }
      kept.push({ id: ++answerFileSequence, file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" });
    }
    if (kept.length > 0) setFiles((current) => [...current, ...kept]);
  };
  const addPath = (path: string): void => setFiles((current) => current.some((each) => "path" in each && each.path === path) ? current : [...current, { id: ++answerFileSequence, path, preview: "" }]);
  const pickDevice = (opts?: { accept?: string; capture?: boolean }): void => {
    const input = fileInput.current;
    if (!input) return;
    if (opts?.accept) input.setAttribute("accept", opts.accept); else input.removeAttribute("accept");
    if (opts?.capture) input.setAttribute("capture", "environment"); else input.removeAttribute("capture");
    input.click();
  };
  const removeFile = (id: number): void => {
    setFiles((current) => current.filter((each) => {
      if (each.id === id && each.preview) URL.revokeObjectURL(each.preview);
      return each.id !== id;
    }));
  };
  const customRef = useRef<HTMLTextAreaElement | null>(null);
  const customValue = useRef(custom);
  customValue.current = custom;
  const { settings } = useSettings();
  const phone = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const dictation = useDictation({
    mode: "chat",
    // the card's own field: only a Copilot card's has a mic
    active: onUploadFile !== undefined,
    connected: true,
    phone,
    polish: settings.voicePolishChat,
    box: customRef,
    read: () => customValue.current,
    write: (value, caret) => {
      customValue.current = value;
      setCustom(value);
      requestAnimationFrame(() => customRef.current?.setSelectionRange(caret, caret));
    },
    onNote: (note) => setError(note === null ? null : { message: note, detail: null }),
  });
  // the answer grows with its lines (CSS field-sizing; measured here where a browser lacks it), up
  // to the CSS cap, past which it scrolls. Once it wraps, it takes the card's width on a line of its
  // own and its buttons go under it (a narrow field by three buttons read a few words a line); it
  // stays so until it is emptied, so the row does not flip back and forth as the text rewraps
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const box = customRef.current;
    if (!box) return;
    if (!CSS.supports("field-sizing", "content")) {
      box.style.height = "auto";
      box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
    }
    if (custom === "") { setWide(false); return; }
    const style = getComputedStyle(box);
    const text = box.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!wide && text > parseFloat(style.lineHeight) * 1.5) setWide(true);
  }, [custom, wide]);
  const attaching = onUploadFile !== undefined;
  const canSend = custom.trim().length > 0 || (attaching && files.length > 0);

  const toggle = (index: number): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  // a Copilot form (VS Code's carousel): one question a page, each page's answer kept here, so
  // the user can go back, read what was picked and change it; Submit sends them all at once
  const form = prompt.form ?? null;
  const [page, setPage] = useState(0);
  const drafts = useRef<FormDraft[]>(form ? form.map(() => ({ selected: [], custom: "", files: [] })) : []);
  const q = form ? form[page] ?? form[0]! : prompt;
  const lastPage = form !== null && page === form.length - 1;
  const current = (): FormDraft => ({ selected: [...selected].sort((a, b) => a - b), custom, files });
  const goTo = (next: number, keep: FormDraft = current()): void => {
    if (form === null || next < 0 || next >= form.length) return;
    drafts.current[page] = keep;
    const shown = drafts.current[next]!;
    setSelected(new Set(shown.selected));
    setCustom(shown.custom);
    setFiles(shown.files);
    setError(null);
    setPage(next);
  };
  const pageAnswered = (index: number): boolean => draftAnswered(index === page ? current() : drafts.current[index]!);
  const submitForm = async (press?: { nativeEvent: Event; currentTarget: EventTarget }): Promise<void> => {
    if (form === null) return;
    drafts.current[page] = current();
    const all = drafts.current;
    const missing = form.findIndex((each, index) => each.required && !draftAnswered(all[index]!));
    if (missing >= 0) {
      if (missing !== page) goTo(missing);
      setError({ message: t("This question needs an answer."), detail: null });
      return;
    }
    setPending(true);
    setError(null);
    const entries: NonNullable<PromptChoice["form"]> = [];
    for (const draft of all) {
      if (!draftAnswered(draft)) { entries.push(null); continue; }
      let text = draft.custom.trim();
      if (draft.files.length > 0 && onUploadFile) {
        const result = await withFiles(text, draft.files, onUploadFile, async (withPaths) => { text = withPaths; });
        if (!shown.current) return;
        if (!result.ok) { setError({ message: result.error, detail: null }); setPending(false); return; }
      }
      entries.push({ option_indices: draft.selected, ...(text !== "" ? { custom_text: text } : {}) });
    }
    await answer({ form: entries }, press);
  };
  const customLabelId = useId();
  // the agent's pick in the label ("Redis (Recommended)", "Recommended: …"): a tag reads better (lib/promptAnswer.ts)
  const labelOf = recommendedLabel;
  const hasChoices = q.options.some((_, index) => index !== q.custom_option_index);
  const openFile = useContext(OpenFileContext);
  const planFile = prompt.plan_file;

  const collapse = (): void => setExpanded(false);
  // width alone: a wide tablet's coarse pointer reaches the header as well as the foot
  const pagerAtFoot = useMediaQuery("(max-width: 640px)");
  const pager = form === null ? null : <>
    <button type="button" className="icon-button" aria-label={t("Previous question")} title={t("Previous question")} disabled={pending || page === 0} onClick={() => goTo(page - 1)}><ChevronLeft aria-hidden="true" /></button>
    <span className="prompt-card-pager-count">{t("{n} of {total}", { n: page + 1, total: form.length })}</span>
    <button type="button" className="icon-button" aria-label={t("Next question")} title={t("Next question")} disabled={pending || lastPage || (form[page]?.required === true && !pageAnswered(page))} onClick={() => goTo(page + 1)}><ChevronRight aria-hidden="true" /></button>
  </>;
  const card = (
    <section className={`prompt-card${folded && !expanded ? " is-folded" : ""}${expanded ? " is-expanded" : ""}`} ref={cardRef} role="region" aria-label={t("Agent is asking")}
      onKeyDown={(event) => { down.current = null; keyed.current = event.key === "Enter" || event.key === " " ? event.target : null; }}
      onPointerDown={(event) => {
        keyed.current = null;
        const button = (event.target as Element).closest("button");
        down.current = button === null ? null : { target: button, pointerType: event.pointerType };
      }}>
      <header className="prompt-card-header">
        {prompt.can_step_back && (
          <button
            type="button"
            className="btn btn-ghost prompt-card-back"
            disabled={pending}
            aria-label={t("Back")}
            title={t("Back")}
            onClick={(event) => void answer({ step_back: true, draft: { option_indices: [...selected], custom_text: custom } }, event)}
          >
            <ArrowLeft aria-hidden="true" />
            <span>{t("Back")}</span>
          </button>
        )}
        {/* read, not drawn: the card says it waits on you */}
        <span className="visually-hidden">{t("input needed")}</span>
        {markdown ? <h2 className="prompt-card-markdown"><Markdown style="vscode">{q.title}</Markdown></h2> : <h2>{q.title}</h2>}
        {pager !== null && !pagerAtFoot && !folded && <nav className="prompt-card-pager is-header" aria-label={t("Questions")}>{pager}</nav>}
        {/* the card shows a plan in its short box; the file viewer draws the whole of it as Markdown */}
        {planFile && openFile && (
          <button type="button" className="btn btn-ghost prompt-card-plan-file" onClick={() => openFile(planFile)}>
            <FileText aria-hidden="true" />{t("View plan")}
          </button>
        )}
        {expandable && (
          <button type="button" className="icon-button prompt-card-expand" aria-label={expanded ? t("Exit full screen") : t("Open full screen")} title={expanded ? t("Exit full screen") : t("Open full screen")}
            aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
        )}
        {/* a typed answer waiting for Confirm keeps the card open, so the fold has nothing to do then; the full-screen card does not fold */}
        {!expanded && <button type="button" className="prompt-card-fold" disabled={typedAnswer?.option_index !== undefined} aria-expanded={!folded} aria-label={t(folded ? "Expand question" : "Collapse question")} title={t(folded ? "Expand question" : "Collapse question")} onClick={() => setFoldedByUser(!folded)}>
          {folded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>}
      </header>
      {/* a form of several questions (omo): each one, answered or not, and the one asked now */}
      {prompt.steps && (
        <ol className="prompt-card-steps" aria-label={t("Questions")}>
          {prompt.steps.map((step, index) => {
            const isClickable = step.answered && !step.current && prompt.can_step_back;
            return (
              <li
                key={index}
                className={`prompt-card-step${step.answered ? " is-answered" : ""}${step.current ? " is-current" : ""}${isClickable ? " is-clickable" : ""}`}
                aria-current={step.current ? "step" : undefined}
              >
                {isClickable ? (
                  <button
                    type="button"
                    className="prompt-card-step-button"
                    disabled={pending}
                    aria-label={step.label}
                    title={t("Back")}
                    onClick={(event) => void answer({ step_index: index, draft: { option_indices: [...selected], custom_text: custom } }, event)}
                  >
                    <span className="prompt-card-step-mark" aria-hidden="true"><Check /></span>
                    <span className="prompt-card-step-label">{step.label}</span>
                    <span className="visually-hidden">{t("(answered)")}</span>
                  </button>
                ) : (
                  <>
                    <span className="prompt-card-step-mark" aria-hidden="true">{step.answered ? <Check /> : index + 1}</span>
                    <span className="prompt-card-step-label">{step.label}</span>
                    {step.answered && <span className="visually-hidden">{t("(answered)")}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {/* a Claude approval's heading is its question too: said once */}
      {q.question !== q.title && (markdown
        ? <div className="prompt-card-question prompt-card-markdown"><Markdown style="vscode">{q.question}</Markdown></div>
        : <p className="prompt-card-question">{q.question}</p>)}
      {prompt.queued && (
        <p className="prompt-card-hint">
          {prompt.queued === "open"
            ? t("Codex keeps working meanwhile. Answer here; the question holds the terminal's input until it is answered or closed.")
            : t("Codex keeps working meanwhile. Answer here; the message box still talks to Codex.")}
        </p>
      )}
      {/* the reference text (a command, a plan, a diff) is the one part that gives way when the card is short */}
      {/* a review's answers (Claude, omp): each question over what was picked for it, read as prose */}
      {prompt.answers && (
        <dl className="prompt-card-answers">
          {prompt.answers.map((item, index) => {
            const answer = item.answer === null ? null : labelOf(item.answer);
            return (
              <div key={index} className="prompt-card-answer">
                {item.question !== null && <dt>{item.question}</dt>}
                <dd className={answer === null ? "is-empty" : undefined}>
                  {answer === null ? t("Not answered") : <>{answer.text}{answer.recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}</>}
                </dd>
                {item.note !== undefined && <dd className="prompt-card-answer-note">{t("Note: {note}", { note: item.note })}</dd>}
              </div>
            );
          })}
        </dl>
      )}
      {prompt.body !== null && prompt.body.length > 0 && (markdown
        ? <div className="prompt-card-body prompt-card-markdown"><Markdown style="vscode">{prompt.body}</Markdown></div>
        : <pre className={`prompt-card-body${prompt.body.includes("\n") ? "" : " is-line"}`}>{prompt.body}</pre>)}
      {hasChoices && (
        /* busy on the options alone, never on the card: a live region inside an aria-busy subtree is not
           read (Chromium), and the status line below has to be */
        <div className="prompt-card-options" role={q.multi_select ? "group" : undefined} aria-label={q.multi_select ? q.question : undefined} aria-busy={pending}>
          {q.options.map((option, index) => {
            if (index === q.custom_option_index) return null;
            const parsed = labelOf(option.label);
            const text = parsed.text;
            const recommended = parsed.recommended || option.recommended === true;
            const content = (
              <span className="prompt-card-option-text">
                <span className="prompt-card-option-label"><span>{text}</span>{recommended && <>{" "}<span className="prompt-card-tag">{t("Recommended")}</span></>}</span>
                {option.description !== null && <span className="prompt-card-option-description">{option.description}</span>}
              </span>
            );
            // the key the user can type, drawn as a keycap; the option's name keeps the menu's "1."
            const number = <span className="prompt-card-number"><span aria-hidden="true">{index + 1}</span><span className="visually-hidden">{index + 1}.</span></span>;
            const described = `${option.description !== null ? " has-description" : ""}${recommended ? " is-recommended" : ""}`;
            if (q.multi_select) {
              const checked = selected.has(index);
              return (
                <label className={`prompt-card-option${described}${checked ? " is-checked" : ""}`} key={index}>
                  <input type="checkbox" checked={checked} disabled={pending} onChange={() => toggle(index)} />
                  {number} {content}
                </label>
              );
            }
            const isSelected = prompt.default_option_index === index;
            return (
              <button key={index} type="button" className={`prompt-card-option${described}${typedAnswer?.option_index === index ? " is-typed" : ""}${form && selected.has(index) ? " is-checked" : ""}${form === null && isSelected ? " is-selected" : ""}`} disabled={pending} aria-pressed={form ? selected.has(index) : undefined}
                onClick={(event) => {
                  if (form === null) { void answer({ option_index: index }, event); return; }
                  // a form's pick is kept, not sent: on to the next question, as VS Code's carousel goes; the last one waits for Submit
                  const keep = { selected: [index], custom: "", files: [] };
                  setSelected(new Set([index])); setCustom(""); setFiles([]); setError(null);
                  if (!lastPage) goTo(page + 1, keep);
                }}>
                {number} {content}
              </button>
            );
          })}
        </div>
      )}
      {q.multi_select && form === null && (
        <button type="button" className={`btn${selected.size > 0 ? " btn-primary" : ""} prompt-card-submit`} disabled={pending || (selected.size === 0 && !("optional" in q && q.optional) && !(prompt.agent === "opencode" && custom.trim()))} onClick={(event) => void answer({ option_indices: [...selected].sort((a, b) => a - b) }, event)}>
          {selected.size > 0 ? t("Submit ({n})", { n: selected.size }) : t("Submit")}
        </button>
      )}
      {q.custom_option_index !== null && (
        <div className="prompt-card-custom">
          {hasChoices && <span className="prompt-card-custom-label" id={customLabelId}>{prompt.agent === "opencode" && q.multi_select ? t("Custom answer") : t("Or type your own answer")}</span>}
          <div className={`prompt-card-custom-row${attaching && wide ? " is-stacked" : ""}`}>
            <textarea ref={customRef} className="input prompt-card-answer" rows={1} value={custom} disabled={pending} placeholder={markdown ? copilotSlot(q.options[q.custom_option_index]?.label, t) : q.options[q.custom_option_index]?.label ?? t("Type an answer")} aria-label={hasChoices ? undefined : t("Custom answer")} aria-labelledby={hasChoices ? customLabelId : undefined} onChange={(event) => setCustom(event.currentTarget.value)} onKeyDown={(event) => {
              // an IME's Enter commits the candidate; WebKit can send it after compositionend, as key code 229.
              // Shift+Enter is a new line in the answer, as in the composer
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (canSend) { if (form === null) void answerCustom(); else if (lastPage) void submitForm(); else goTo(page + 1); }
            }} {...(attaching ? { onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
              const pasted = Array.from(event.clipboardData.files);
              if (pasted.length === 0) return;
              event.preventDefault();
              addFiles(pasted);
            } } : {})} />
            {attaching && <>
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => {
                const picked = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                event.currentTarget.removeAttribute("accept");
                event.currentTarget.removeAttribute("capture");
                addFiles(picked);
              }} />
              <button type="button" className="icon-button prompt-card-attach" aria-label={t("Attach files")} title={t("Attach files")} disabled={pending} onClick={() => { if (attachSheet) setAttachOpen(true); else pickDevice(); }}>
                <Plus aria-hidden="true" />
              </button>
              {dictation.shown && <MicButton dictation={dictation} className="prompt-card-mic" />}
            </>}
            {form === null && <button type="button" className={`btn${canSend ? " btn-primary" : ""}`} disabled={pending || !canSend} onClick={(event) => void answerCustom(event)}>
              <Send aria-hidden="true" /> {t("Send")}
            </button>}
          </div>
          {attachOpen && attachSheet && <AttachSheet machineId={attachSheet.machineId} session={attachSheet.session} onClose={() => setAttachOpen(false)}
            api={{ pickFiles: pickDevice, addPicked: addPath, addFile: (file) => addFiles([file]) }} />}
          {attaching && dictation.shown && <VoiceRecordingPill dictation={dictation} align="start" />}
          {files.length > 0 && (
            <div className="composer-attachments prompt-card-files" aria-label={t("Attached files")}>
              {files.map((each) => (
                <div className="composer-attachment is-ready" key={each.id}>
                  {each.preview ? <img src={each.preview} alt={fileName(each)} />
                    : <span className="composer-attachment-file" title={"path" in each ? each.path : each.file.name}><FileText aria-hidden="true" /><span>{fileName(each)}</span></span>}
                  <button type="button" aria-label={t("Remove {file}", { file: fileName(each) })} disabled={pending} onClick={() => removeFile(each.id)}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {prompt.optional && !prompt.multi_select && (
        <button type="button" className="btn prompt-card-skip" disabled={pending} onClick={(event) => void answer({ custom_text: "" }, event)}>
          {t("Skip question")}
        </button>
      )}
      {typedAnswer?.option_index !== undefined && (
        <div className="prompt-card-confirm" role="alert" ref={confirmRef}>
          {/* an option's label can run to pages (a review to approve): the question shows two lines
              of it and scrolls in itself, and the two buttons stay whole, on one line */}
          <span className="prompt-card-confirm-text">{t("Send {answer}?", { answer: `${typedAnswer.option_index + 1}. ${q.options[typedAnswer.option_index]?.label ?? ""}` })}</span>
          <span className="prompt-card-confirm-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={(event) => void answer(typedAnswer, event).then((current) => { if (current) onTypedAnswerDone?.(); })}>{t("Confirm")}</button>
            <button type="button" className="btn" disabled={pending} onClick={() => onTypedAnswerDone?.()}>{t("Cancel")}</button>
          </span>
        </div>
      )}
      {/* in the card from its first render, clipped while empty (never display: none): a live region that
          appears together with its words is not read; one that is there and gets them is */}
      {/* a form's pager (VS Code's carousel footer): back and forth, every answer kept; Next waits on a
          required question's answer, an optional one may stay empty; Submit sends the lot */}
      {/* on a mouse window the pager sits in the header beside the title, as VS Code's carousel does: a
          footer row of its own held three small controls under a wide card (owner, ZAC-207). A phone
          keeps it at the foot, in the thumb's reach; Submit stays at the foot on both */}
      {form !== null && (pagerAtFoot ? pager : lastPage) && (
        <nav className="prompt-card-pager" aria-label={pagerAtFoot ? t("Questions") : undefined}>
          {pagerAtFoot && pager}
          {lastPage && <button type="button" className="btn btn-primary prompt-card-pager-submit" disabled={pending} onClick={(event) => void submitForm(event)}>{t("Submit")}</button>}
        </nav>
      )}
      <p className={pending || stale ? "prompt-card-status" : "visually-hidden"} role="status">{pending ? t("Sending your answer…") : stale ? t("Not updated: the question on screen may have changed.") : null}</p>
      {error !== null && <p className="prompt-card-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}
    </section>
  );
  return expanded ? <PromptCardSheet label={t("Agent is asking")} onClose={collapse}>{card}</PromptCardSheet> : card;
}

let answerFileSequence = 0;

/**
 * A Copilot card opened to the full height (the app's sheet: focus trap, swipe down, Back and
 * Escape close it). The card inside is the same one: its owner keeps its step, picks and text.
 */
function PromptCardSheet({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  // stays up under a sheet opened from it (the + sheet): that sheet's close steps history back, which
  // must not collapse the card while the phone's picker is open, or the picked file lands on a
  // detached input and is lost (owner's phone, ZAC-233)
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-scrim prompt-card-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal prompt-card-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
