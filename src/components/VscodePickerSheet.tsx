/**
 * The VS Code chat's model and agent picker: a sheet over the chat (a bottom sheet on a phone).
 * Models are grouped by their provider (lib/vscodeChats.ts groupModels: the host's own, Copilot,
 * first); a model with a
 * reasoning-effort choice offers its values as chips. Agents start with "Agent", VS Code's own
 * (no custom agent). A pick is the chat's next message's (lib/vscodeChats.ts `choose`); a model
 * pick is also written into the chat's shared draft, so VS Code's own model picker follows it.
 * VS Code's agent picker does not, and the sheet says so.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import type { VscodeAgent, VscodeModel } from "../../shared/vscode.ts";
import { useT } from "../lib/i18n.ts";
import { groupModels } from "../lib/vscodeChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

export interface VscodePickerSheetProps {
  /** which part the sheet opened at: the model pill opens the models, the agent pill the agents */
  focus: "model" | "agent";
  models: VscodeModel[] | null;
  agents: VscodeAgent[] | null;
  /** the model and effort the chat's next message uses */
  model: { id: string; effort: string | null } | null;
  /** the agent's uri, or null for "Agent" */
  agent: string | null;
  error: string | null;
  onModel(model: { id: string; effort?: string }): void;
  onAgent(agent: string | null): void;
  onClose(): void;
}

export function VscodePickerSheet({ focus, models, agents, model, agent, error, onModel, onAgent, onClose }: VscodePickerSheetProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const agentsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focus === "agent") agentsRef.current?.scrollIntoView({ block: "start" });
  }, [focus, agents]);
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

  const current = models?.find((each) => each.id === model?.id) ?? null;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal vscode-picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Model and agent")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body vscode-picker-body">
          {error !== null && <p className="vscode-picker-error" role="alert">{error}</p>}
          <section className="vscode-picker-section" aria-labelledby={`${id}-models`}>
            <h3 className="vscode-picker-label" id={`${id}-models`}>{t("Model")}</h3>
            {models === null ? <p className="vscode-picker-state" role="status">{t("Loading…")}</p>
              : models.length === 0 ? <p className="vscode-picker-state">{t("This PC's VS Code offers no models")}</p>
                : groupModels(models).map((group) => (
                  <div className="vscode-picker-group" key={group.provider ?? ""} role="group" aria-label={group.provider ?? t("Copilot")}>
                    <p className="vscode-picker-provider">{group.provider ?? t("Copilot")}</p>
                    {group.models.map((each) => {
                      const picked = each.id === model?.id;
                      return <button key={each.id} type="button" className={`vscode-picker-option${picked ? " is-picked" : ""}`} aria-pressed={picked} data-model={each.id}
                        onClick={() => onModel(each.efforts && picked && model?.effort ? { id: each.id, effort: model.effort } : { id: each.id })}>
                        <span className="vscode-picker-option-name">{each.name}</span>
                        <span className="vscode-picker-option-id">{each.id}</span>
                        {picked && <Check className="vscode-picker-check" aria-hidden="true" />}
                      </button>;
                    })}
                  </div>
                ))}
            {current?.efforts && current.efforts.values.length > 0 && (
              <div className="vscode-picker-efforts" role="group" aria-label={t("Reasoning effort")}>
                <p className="vscode-picker-provider">{t("Reasoning effort")}</p>
                <div className="vscode-picker-chips">
                  {current.efforts.values.map((value) => (
                    <button key={value} type="button" className={`vscode-picker-chip${model?.effort === value ? " is-picked" : ""}`} aria-pressed={model?.effort === value} data-effort={value}
                      onClick={() => onModel({ id: current.id, effort: value })}>{value}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
          <section className="vscode-picker-section" ref={agentsRef} aria-labelledby={`${id}-agents`}>
            <h3 className="vscode-picker-label" id={`${id}-agents`}>{t("Agents")}</h3>
            <div className="vscode-picker-group">
              <button type="button" className={`vscode-picker-option${agent === null ? " is-picked" : ""}`} aria-pressed={agent === null} data-agent="" onClick={() => onAgent(null)}>
                <span className="vscode-picker-option-name">{t("Agent")}</span>
                {agent === null && <Check className="vscode-picker-check" aria-hidden="true" />}
              </button>
              {(agents ?? []).map((each) => {
                const picked = each.uri === agent;
                return <button key={each.uri} type="button" className={`vscode-picker-option${picked ? " is-picked" : ""}`} aria-pressed={picked} data-agent={each.uri} onClick={() => onAgent(each.uri)}>
                  <span className="vscode-picker-option-name">{each.name}</span>
                  {each.description && <span className="vscode-picker-option-id">{each.description}</span>}
                  {picked && <Check className="vscode-picker-check" aria-hidden="true" />}
                </button>;
              })}
            </div>
            <p className="vscode-picker-note">{t("VS Code's agent picker does not follow this choice; a message typed in VS Code uses VS Code's agent.")}</p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
