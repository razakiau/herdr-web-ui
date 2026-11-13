/**
 * A question a Copilot turn asked and the user answered, as VS Code's conversation summary reads it
 * (chatQuestionCarouselPart.ts renderConversationSummary at 6d62b1d): a muted "Question: {text}" on
 * one line, then under an L connector a comment icon and "Answered: {answer}", which opens to the
 * options with a check by the chosen one, or "Custom answer: {text}". Skipped: "Skipped question".
 * An answer the bridge assumed while the user was away (ask_user_async, ZAC-326) reads "Assumed:",
 * with "You were away · Change" under it: Change lists the options, and the one picked goes to the
 * agent as a correction.
 */
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, FileText, MessageSquare, X } from "lucide-react";

import type { ConversationPart } from "../../shared/protocol.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { answerHost } from "../lib/hostChats.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { Markdown } from "./Markdown.tsx";

export type QuestionPart = Extract<ConversationPart, { kind: "question" }>;

/**
 * The answer in one line, as VS Code formats it (formatAnswerForSummary): a single choice's typed
 * text wins over its pick; several picks and the typed text are joined.
 */
export function answerText(part: QuestionPart, multi = part.multi === true): string {
  if (multi) return [...part.chosen, ...(part.custom !== null ? [part.custom] : [])].join(", ");
  return part.custom ?? part.chosen.join(", ");
}

/** A report's first line as plain words: its heading's or list's mark and emphasis dropped. */
export function reportHeadline(report: string): string {
  const line = report.split("\n").map((each) => each.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2").trim()).find((each) => each !== "");
  return (line ?? "").replace(/[:\s]+$/, "");
}

/** `memoryKey`: where the chat's row memory keeps it opened (one per question of a turn). */
/** `attached`: the answer's pictures, drawn by the chat (ChatView's gallery) under its answer. */
export function QuestionSummary({ part, memoryKey = "question", attached = null }: { part: QuestionPart; memoryKey?: string; attached?: React.ReactNode }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(memoryKey, false);
  // the report the question came with (a Copilot ask_user message), folded as VS Code folds work
  const [reportShown, setReportShown] = useChatRowToggle(`${memoryKey}:report`, false);
  const report = part.report ?? null;
  const canOpen = part.options.length > 0 && !part.skipped;
  const open = canOpen && chosen === true;
  // VS Code drops the question's trailing colon and spaces
  const question = part.text.replace(/[:\s]+$/, "");
  const pictures = part.images?.length ?? 0;
  const answer = answerText(part) || (pictures > 0 ? t(pictures === 1 ? "1 image" : "{n} images", { n: pictures }) : "");
  const Icon = part.skipped ? X : MessageSquare;
  const label = <>
    <Icon className="question-summary-answer-icon" aria-hidden="true" />
    {part.skipped
      ? <span className="question-summary-answer-value">{t("Skipped question")}</span>
      : <><span className={`question-summary-prefix${part.assumed ? " is-assumed" : ""}`}>{part.assumed ? t("Assumed:") : t("Answered:")}</span> <span className="question-summary-answer-value" title={answer}>{answer}</span></>}
    {canOpen && <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>}
  </>;
  // the report a form came with leads it, folded to its first line; the question follows, unless
  // it is only that line again (an ask with no form: its message is the question and the report)
  const headline = report !== null ? reportHeadline(report) : "";
  const showQuestion = report === null || headline !== question;
  return <div className="question-summary" role="group" aria-label={t("Answered chat questions")}>
    {report !== null && <div className="question-summary-report">
      <button type="button" className="question-summary-report-toggle" aria-expanded={reportShown === true} onClick={() => setReportShown(reportShown !== true)}>
        <FileText className="question-summary-answer-icon" aria-hidden="true" />
        <span className="question-summary-prefix">{t("Report:")}</span> <span className="question-summary-question-value" title={headline}>{headline}</span>
        <span className="work-row-caret" aria-hidden="true">{reportShown === true ? <ChevronDown /> : <ChevronRight />}</span>
      </button>
      {reportShown === true && <div className="question-summary-report-body"><Markdown style="vscode">{report}</Markdown></div>}
    </div>}
    {showQuestion && <p className="question-summary-question">
      <span className="question-summary-prefix">{t("Question:")}</span> <span className="question-summary-question-value" title={question}>{question}</span>
    </p>}
    <div className="question-summary-decision">
      {canOpen
        ? <button type="button" className="question-summary-answer" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
        : <div className="question-summary-answer">{label}</div>}
      {open && <div className="question-summary-options">
        <p className="question-summary-options-title">{t("Options")}</p>
        <ul className="question-summary-option-list">
          {part.options.map((option, index) => {
            const selected = part.chosen.includes(option);
            return <li key={index} className={`question-summary-option${selected ? " is-selected" : ""}`} aria-label={selected ? t("{label}, selected", { label: option }) : undefined}>
              <span className="question-summary-option-label">{option}</span>
              {selected && <Check className="question-summary-option-check" aria-hidden="true" />}
            </li>;
          })}
          {part.custom !== null && <li className="question-summary-option is-selected" aria-label={t("Custom answer: {text}, selected", { text: part.custom })}>
            <span className="question-summary-option-label">{t("Custom answer: {text}", { text: part.custom })}</span>
            <Check className="question-summary-option-check" aria-hidden="true" />
          </li>}
        </ul>
      </div>}
      {part.assumed && <AssumedAnswer part={part} />}
    </div>
    {attached}
  </div>;
}

/**
 * Under an assumed answer: "You were away", and Change while the bridge still holds it (`correctable`).
 * Change lists the question's options, the assumed one pressed (and disabled: re-picking it changes nothing); the one picked is sent as a
 * correction (answerHost with `correction`), and the line says so until the transcript reads it.
 */
function AssumedAnswer({ part }: { part: QuestionPart }) {
  const t = useT();
  const machineId = useMachineId();
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const target = part.correctable ?? null;
  const change = async (index: number): Promise<void> => {
    if (target === null || sending) return;
    setSending(true); setFailed(false);
    try {
      await answerHost(machineId, { session: target.session, async_id: target.async_id, option_ids: [String(index)], correction: true });
      setSent(part.options[index] ?? ""); setPicking(false);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  if (sent !== null) return <p className="question-summary-away">{t("Changed to {label}", { label: sent })}</p>;
  return <>
    <p className="question-summary-away">
      {t("You were away")}
      {target !== null && part.options.length > 0 && <>{" · "}<button type="button" className="question-summary-change" aria-expanded={picking} onClick={() => { setPicking(!picking); setFailed(false); }}>{t("Change")}</button></>}
    </p>
    {picking && <div className="question-summary-change-options" role="group" aria-label={t("Change the assumed answer")}>
      {part.options.map((option, index) => <button key={index} type="button" className="question-summary-change-option" disabled={sending || part.chosen.includes(option)} aria-pressed={part.chosen.includes(option)} onClick={() => void change(index)}>{option}</button>)}
    </div>}
    {failed && <p className="question-summary-change-error" role="alert">{t("Couldn't send the change. Try again.")}</p>}
  </>;
}
