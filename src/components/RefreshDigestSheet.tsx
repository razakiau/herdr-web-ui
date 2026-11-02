/**
 * Chat groups (ZAC-265 PR 2), "Refresh the digest" (spec §4 Sheets): the model (OmniRoute's ids,
 * the current one picked, each with its person's name), the effort (Low / Medium / High), what the
 * refresh will cost ("≈ $0.003 · 2 chat summaries + 1 group pass · ~38K tokens in") and Write digest.
 * The model and effort picked become the group digests' default (onSave; the server keeps them).
 * The sheet frame and the rows are Add to group's (AddToGroupSheet.css), the effort the app's
 * segmented control.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import "./NewSessionDialog.css";
import "./AddToGroupSheet.css";
import "./DigestCard.css";

import type { DigestEffort, DigestEstimate } from "../../shared/groups.ts";
import { estimateParts } from "../lib/digest.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { digestModelName } from "./DigestCard.tsx";

export interface RefreshDigestSheetProps {
  models: readonly string[];
  model: string;
  effort: DigestEffort;
  /** what a refresh would cost with this model and effort; null while it is worked out */
  estimate(model: string, effort: DigestEffort): DigestEstimate | null;
  onSave(pick: { model: string; effort: DigestEffort }): void;
  onClose(): void;
}

const EFFORTS: DigestEffort[] = ["low", "medium", "high"];

export function RefreshDigestSheet({ models, model, effort, estimate, onSave, onClose }: RefreshDigestSheetProps) {
  const t = useT();
  const id = useId();
  const [pickedModel, setModel] = useState(model);
  const [pickedEffort, setEffort] = useState<DigestEffort>(effort);
  const dialog = useRef<HTMLDivElement | null>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: dialog });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => onClose());
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const guess = estimate(pickedModel, pickedEffort);
  const parts = guess ? estimateParts(guess) : null;
  const effortLabel = (each: DigestEffort): string => each === "high" ? t("High") : each === "medium" ? t("Medium") : t("Low");
  // the current model first if OmniRoute no longer lists it, so the pick is never lost
  const list = models.includes(model) ? models : [model, ...models];

  return createPortal(
    <div className="modal-scrim new-session-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={(node) => { surface.current = node; dialog.current = node; }} className="modal new-session-modal add-to-group refresh-digest" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Refresh the digest")}</h2></header>
        <div className="modal-body add-to-group-body">
          <h3 className="sidebar-section-label refresh-digest-label" id={`${id}-model`}>{t("Model")}</h3>
          <div className="add-to-group-list refresh-digest-models" role="radiogroup" aria-labelledby={`${id}-model`}>
            {list.map((each) => {
              const on = each === pickedModel;
              const name = digestModelName(each);
              return <button key={each} type="button" role="radio" aria-checked={on} className={`add-to-group-row${on ? " is-on" : ""}`} onClick={() => setModel(each)}>
                <span className="add-to-group-check" aria-hidden="true">{on && <Check />}</span>
                <span className="add-to-group-text">{name}{name !== each && <small className="refresh-digest-id">{each}</small>}</span>
              </button>;
            })}
          </div>
          <h3 className="sidebar-section-label refresh-digest-label" id={`${id}-effort`}>{t("Effort")}</h3>
          <div className="segmented refresh-digest-effort" role="group" aria-labelledby={`${id}-effort`}>
            {EFFORTS.map((each) => <button key={each} type="button" aria-pressed={pickedEffort === each} onClick={() => setEffort(each)}>{effortLabel(each)}</button>)}
          </div>
          <p className="refresh-digest-estimate" role="status">{guess && parts
            ? <>
              <strong>{parts.usd}</strong>
              <span aria-hidden="true">·</span>
              <span>{t(guess.chats === 1 ? "1 chat summary" : "{n} chat summaries", { n: guess.chats })} + {t(guess.groupPasses === 1 ? "1 group pass" : "{n} group passes", { n: guess.groupPasses })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("{tokens} tokens in", { tokens: parts.tokens })}</span>
            </>
            : t("Working out the cost…")}</p>
          <p className="refresh-digest-note">{t("Only chats with new turns are summarised again. The model and effort stay the default for every group.")}</p>
        </div>
        <footer className="modal-footer add-to-group-footer">
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="btn btn-primary add-to-group-go" onClick={() => { onSave({ model: pickedModel, effort: pickedEffort }); onClose(); }}>{t("Write digest")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
