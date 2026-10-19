/**
 * A question a Copilot turn asked and the user answered, as VS Code's conversation summary reads it
 * (chatQuestionCarouselPart.ts renderConversationSummary at 6d62b1d): a muted "Question: {text}" on
 * one line, then under an L connector a comment icon and "Answered: {answer}", which opens to the
 * options with a check by the chosen one, or "Custom answer: {text}". Skipped: "Skipped question".
 */
import { Check, ChevronDown, ChevronRight, MessageSquare, X } from "lucide-react";

import type { ConversationPart } from "../../shared/protocol.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { useT } from "../lib/i18n.ts";

export type QuestionPart = Extract<ConversationPart, { kind: "question" }>;

/**
 * The answer in one line, as VS Code formats it (formatAnswerForSummary): a single choice's typed
 * text wins over its pick; several picks and the typed text are joined.
 */
export function answerText(part: QuestionPart, multi = part.multi === true): string {
  if (multi) return [...part.chosen, ...(part.custom !== null ? [part.custom] : [])].join(", ");
  return part.custom ?? part.chosen.join(", ");
}

/** `memoryKey`: where the chat's row memory keeps it opened (one per question of a turn). */
export function QuestionSummary({ part, memoryKey = "question" }: { part: QuestionPart; memoryKey?: string }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(memoryKey, false);
  const canOpen = part.options.length > 0 && !part.skipped;
  const open = canOpen && chosen === true;
  // VS Code drops the question's trailing colon and spaces
  const question = part.text.replace(/[:\s]+$/, "");
  const answer = answerText(part);
  const Icon = part.skipped ? X : MessageSquare;
  const label = <>
    <Icon className="question-summary-answer-icon" aria-hidden="true" />
    {part.skipped
      ? <span className="question-summary-answer-value">{t("Skipped question")}</span>
      : <><span className="question-summary-prefix">{t("Answered:")}</span> <span className="question-summary-answer-value" title={answer}>{answer}</span></>}
    {canOpen && <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>}
  </>;
  return <div className="question-summary" role="group" aria-label={t("Answered chat questions")}>
    <p className="question-summary-question">
      <span className="question-summary-prefix">{t("Question:")}</span> <span className="question-summary-question-value" title={question}>{question}</span>
    </p>
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
    </div>
  </div>;
}
