/**
 * Hand off & continue's message step (ZAC-267): the owner may tell the new chat what to do next. A
 * field like the composer's with its send arrow inside, and ✕ to cancel; the arrow (or the send key
 * the composer uses) hands off, empty for no message. The bridge queues the text in the new chat
 * behind its /resume. Shown in place of the button, in the Session sheet and the banner alike (owner:
 * one tap more, never a second "Hand off" button, and clean in the banner).
 */
import { ArrowUp, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";

export interface HandoffStepProps {
  onSend(message: string): void;
  onCancel(): void;
  /** the hand-off is starting: the arrow waits */
  busy?: boolean;
}

export function HandoffStep({ onSend, onCancel, busy = false }: HandoffStepProps) {
  const t = useT();
  const { settings } = useSettings();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  // grows with its text, as the composer does, up to a few lines
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [text]);
  const send = (): void => { if (!busy) onSend(text.trim()); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const sends = settings.enterSends ? !event.shiftKey && !event.metaKey && !event.ctrlKey : (event.metaKey || event.ctrlKey) && !event.shiftKey;
    if (!sends) return;
    event.preventDefault();
    send();
  };
  // one row, as the composer: the field, ✕ and the send disc inside one box. The words that would
  // be a label are the placeholder and the field's name: a label row read as a form (owner, ZAC-267)
  return <div className="handoff-step">
    <div className="handoff-step-box">
      <textarea ref={field} className="handoff-step-input" rows={1} value={text} aria-label={t("Then tell the new chat (optional)")}
        placeholder={t("Message the new chat…")} enterKeyHint="send" onChange={(event) => setText(event.target.value)} onKeyDown={onKey} />
      <button type="button" className="icon-button handoff-step-cancel" aria-label={t("Cancel")} title={t("Cancel")} onClick={onCancel}>
        <X aria-hidden="true" />
      </button>
      <button type="button" className="composer-action composer-send handoff-step-send" aria-label={t("Hand off")} title={t("Hand off")} disabled={busy} onClick={send}>
        <ArrowUp aria-hidden="true" />
      </button>
    </div>
  </div>;
}
