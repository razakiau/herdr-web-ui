/**
 * The host chat's model and agent picker: a sheet over the chat (a bottom sheet on a phone).
 * Models are grouped by their provider (lib/hostChats.ts groupModels: the host's own, Copilot,
 * first); a model with a
 * reasoning-effort choice offers its values as chips. Agents start with "Agent", VS Code's own
 * (no custom agent). A pick is the chat's next message's (lib/hostChats.ts `choose`); a model
 * pick is also written into the chat's shared draft, so VS Code's own model picker follows it.
 * VS Code's agent picker does not, and the sheet says so.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import type { HostAgent, HostModel } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { groupModels } from "../lib/hostChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

export interface VscodePickerSheetProps {
  /** which part the sheet opened at: the model pill opens the models, the agent pill the agents */
  focus: "model" | "agent";
  models: HostModel[] | null;
  agents: HostAgent[] | null;
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
      <div ref={surface} className="modal host-picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Model and agent")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body host-picker-body">
          {error !== null && <p className="host-picker-error" role="alert">{error}</p>}
          <section className="host-picker-section" aria-labelledby={`${id}-models`}>
            <h3 className="host-picker-label" id={`${id}-models`}>{t("Model")}</h3>
            {models === null ? <p className="host-picker-state" role="status">{t("Loading…")}</p>
              : models.length === 0 ? <p className="host-picker-state">{t("Copilot on this PC offers no models")}</p>
                : groupModels(models).map((group) => (
                  <div className="host-picker-group" key={group.provider ?? ""} role="group" aria-label={group.provider ?? t("Copilot")}>
                    <p className="host-picker-provider">{group.provider ?? t("Copilot")}</p>
                    {group.models.map((each) => {
                      const picked = each.id === model?.id;
                      return <button key={each.id} type="button" className={`host-picker-option${picked ? " is-picked" : ""}`} aria-pressed={picked} data-model={each.id}
                        onClick={() => onModel(each.efforts && picked && model?.effort ? { id: each.id, effort: model.effort } : { id: each.id })}>
                        <span className="host-picker-option-name">{each.name}</span>
                        <span className="host-picker-option-id">{each.id}</span>
                        {picked && <Check className="host-picker-check" aria-hidden="true" />}
                      </button>;
                    })}
                  </div>
                ))}
            {current?.efforts && current.efforts.values.length > 0 && (
              <div className="host-picker-efforts" role="group" aria-label={t("Reasoning effort")}>
                <p className="host-picker-provider">{t("Reasoning effort")}</p>
                <div className="host-picker-chips">
                  {current.efforts.values.map((value) => (
                    <button key={value} type="button" className={`host-picker-chip${model?.effort === value ? " is-picked" : ""}`} aria-pressed={model?.effort === value} data-effort={value}
                      onClick={() => onModel({ id: current.id, effort: value })}>{value}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
          <section className="host-picker-section" ref={agentsRef} aria-labelledby={`${id}-agents`}>
            <h3 className="host-picker-label" id={`${id}-agents`}>{t("Agents")}</h3>
            <div className="host-picker-group">
              <button type="button" className={`host-picker-option${agent === null ? " is-picked" : ""}`} aria-pressed={agent === null} data-agent="" onClick={() => onAgent(null)}>
                <span className="host-picker-option-name">{t("Agent")}</span>
                {agent === null && <Check className="host-picker-check" aria-hidden="true" />}
              </button>
              {(agents ?? []).map((each) => {
                const picked = each.uri === agent;
                return <button key={each.uri} type="button" className={`host-picker-option${picked ? " is-picked" : ""}`} aria-pressed={picked} data-agent={each.uri} onClick={() => onAgent(each.uri)}>
                  <span className="host-picker-option-name">{each.name}</span>
                  {each.description && <span className="host-picker-option-id">{each.description}</span>}
                  {picked && <Check className="host-picker-check" aria-hidden="true" />}
                </button>;
              })}
            </div>
            <p className="host-picker-note">{t("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.")}</p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
