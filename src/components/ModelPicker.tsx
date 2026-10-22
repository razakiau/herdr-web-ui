/**
 * A host chat's pickers, as VS Code's model picker reads them (modelPickerTabs, Pinned and Recent,
 * one line per model with its mark and "High · 1M"), then the models by where they come from:
 * Copilot's catalogue with its premium-request rate, each router by vendor, the rest), its agent picker
 * ("Agent" first, then the host's custom agents), and the chat's mode and permissions
 * (agentHostModePickerPresentation.ts: Interactive / Plan / Autopilot, Manual / Assisted / Allow all).
 * A sheet on a phone, a dialog on a desktop. The model and agent are the next message's (a pick is
 * carried by every send); the mode and permissions are the chat's, written once to its host.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Pin, Search, Sparkles, TriangleAlert, X } from "lucide-react";

import type { HostAgent, HostModel, HostSessionConfig } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { filterModels, groupName, modelGroupOf, modelTabs, multiplierLabel, pickerSections, pinnedModels, providerMark, recentModels, rememberRecent, rowDetail, SECTION_TITLES, togglePinned, type ModelMark, type PickerSection } from "../lib/modelProvider.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { AgentMark } from "./AgentMark.tsx";

/** A model's mark: the provider's, or VS Code's sparkle for one it cannot name. */
export function ModelMarkIcon({ mark, size = 14 }: { mark: ModelMark; size?: number }) {
  return mark === "sparkle"
    ? <span className="agent-mark model-mark-sparkle"><Sparkles width={size} height={size} role="img" aria-label="sparkle" /></span>
    : <AgentMark agent={mark} size={size} />;
}

/** VS Code's words for the host's values: the mode's from its schema, the permissions' short ones. */
export const MODE_LABEL: Record<string, string> = {
  interactive: "Interactive",
  plan: "Plan",
  autopilot: "Autopilot",
};
export const APPROVALS_LABEL: Record<string, string> = {
  default: "Manual",
  assisted: "Assisted",
  autoApprove: "Allow all",
};
/** VS Code's hover for each permission level (agentHostChatInputPicker.ts getAutoApproveHover). */
const APPROVALS_HINT: Record<string, string> = {
  default: "Copilot asks before running tools unless your configured settings allow the tool.",
  assisted: "An LLM judge evaluates each tool call. Tools it doesn't approve require your approval.",
  autoApprove: "Copilot runs all tools without asking for approval.",
};
const AGENT_SEARCH_FROM = 8;
const LONG_PRESS_MS = 500;

export interface ModelPickerProps {
  machineId: string;
  /** which picker the pill opened */
  focus: "model" | "agent" | "mode";
  models: HostModel[] | null;
  agents: HostAgent[] | null;
  /** the model and effort the chat's next message uses */
  model: { id: string; effort: string | null } | null;
  /** the agent's uri, or null for "Agent" */
  agent: string | null;
  config: HostSessionConfig | null;
  error: string | null;
  onModel(model: { id: string; effort?: string }): void;
  onAgent(agent: string | null): void;
  onConfig(change: { mode?: string; approvals?: string }): void;
  onClose(): void;
}

export function ModelPicker({ machineId, focus, models, agents, model, agent, config, error, onModel, onAgent, onConfig, onClose }: ModelPickerProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
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

  const title = focus === "model" ? t("Model") : focus === "agent" ? t("Agent") : t("Agent mode");
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal host-picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-picker={focus}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body host-picker-body">
          {error !== null && <p className="host-picker-error" role="alert">{error}</p>}
          {focus === "model" && <ModelList machineId={machineId} models={models} model={model} onModel={onModel} />}
          {focus === "agent" && <AgentList agents={agents} agent={agent} onAgent={onAgent} />}
          {focus === "mode" && <ModeList config={config} onConfig={onConfig} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModelList({ machineId, models, model, onModel }: Pick<ModelPickerProps, "machineId" | "models" | "model" | "onModel">) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<string | null>(null);
  const [pinned, setPinned] = useState(() => pinnedModels(machineId));
  const [recent] = useState(() => recentModels(machineId));
  const [efforts, setEfforts] = useState<string | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const tabs = useMemo(() => modelTabs(models ?? []), [models]);
  if (models === null) return <p className="host-picker-state" role="status">{t("Loading…")}</p>;
  if (models.length === 0) return <p className="host-picker-state">{t("Copilot on this PC offers no models")}</p>;
  const shown = filterModels(models, query, tab);
  // a search or a tab keeps the groups but drops Pinned and Recent, which would only repeat its matches
  const searching = query.trim() !== "" || tab !== null;
  const sections = pickerSections(shown, searching ? [] : pinned, searching ? [] : recent);
  // Pinned, Recent and the two groups the app names are words; a router's name is its id prefix
  const word = (key: string, title: string): string => (SECTION_TITLES as readonly string[]).includes(title) && ["pinned", "recent", "copilot", "other"].includes(key) ? t(title) : title;
  const heading = (section: PickerSection): string => word(section.key.split("\n")[0] ?? "", section.title);
  const pick = (next: { id: string; effort?: string }): void => { rememberRecent(machineId, next.id); onModel(next); };
  return <>
    {/* the search and the provider tabs stay at the top while a long list scrolls under them */}
    <div className="host-picker-head">
    <label className="host-picker-search">
      <Search aria-hidden="true" />
      <input className="input" type="search" value={query} placeholder={t("Search models")} aria-label={t("Search models")} autoFocus onChange={(event) => setQuery(event.target.value)} />
    </label>
    {tabs.length > 0 && <div className="host-picker-tabs" role="tablist" aria-label={t("Providers")}>
      {[null, ...tabs].map((each) => {
        const name = each === null ? t("All") : word(each, groupName(each));
        const count = each === null ? models.length : models.filter((model) => modelGroupOf(model) === each).length;
        return <button key={each ?? ""} type="button" role="tab" aria-selected={tab === each} className={`host-picker-tab${tab === each ? " is-picked" : ""}`} data-group={each ?? ""}
          aria-label={count === 1 ? t("{name}, 1 model", { name }) : t("{name}, {count} models", { name, count: String(count) })} onClick={() => setTab(each)}>
          {name}<span className="host-picker-tab-count" aria-hidden="true">{count}</span>
        </button>;
      })}
    </div>}
    </div>
    {shown.length === 0 && <p className="host-picker-state">{t("No models match")}</p>}
    {sections.map((section) => <section key={section.key} className="host-picker-group" aria-label={section.vendor ? `${heading(section)} · ${section.vendor}` : heading(section)}>
      <p className="host-picker-provider">{heading(section)}{section.vendor && <span className="host-picker-vendor"> · {section.vendor}</span>}</p>
      {section.models.map((each) => {
        const picked = each.id === model?.id;
        const effort = picked ? model?.effort ?? null : null;
        const detail = rowDetail(each, effort);
        // a model can stand in two sections (Recent and its group): its effort choices open in the one tapped
        const row = `${section.key}\n${each.id}`;
        const rate = multiplierLabel(each);
        return <div key={each.id} className={`host-model-row${picked ? " is-picked" : ""}`} data-model={each.id}>
          <button type="button" className="host-model-pick" aria-pressed={picked}
            onPointerDown={() => { const held = { fired: false, timer: setTimeout(() => { held.fired = true; togglePinned(machineId, each.id); setPinned(pinnedModels(machineId)); }, LONG_PRESS_MS) }; press.current = held; }}
            onPointerUp={() => { if (press.current && !press.current.fired) clearTimeout(press.current.timer); }}
            onPointerLeave={() => { if (press.current && !press.current.fired) clearTimeout(press.current.timer); }}
            onClick={() => {
              const held = press.current;
              press.current = null;
              if (held?.fired) return;
              pick(each.efforts && picked && model?.effort ? { id: each.id, effort: model.effort } : { id: each.id });
            }}>
            {picked ? <Check className="host-model-check" aria-hidden="true" /> : <span className="host-model-check" aria-hidden="true" />}
            <ModelMarkIcon mark={providerMark(each)} />
            <span className="host-model-name">{section.vendor ? each.name.replace(/\s*\([^()]*\)\s*$/, "") || each.name : each.name}</span>
            {each.warning && <TriangleAlert className="host-model-warning" role="img" aria-label={each.warning}><title>{each.warning}</title></TriangleAlert>}
            {pinned.includes(each.id) && <Pin className="host-model-pin" aria-label={t("Pinned")} />}
            {rate !== null && <span className="host-model-rate" title={t("Premium requests per message")}>{rate}</span>}
          </button>
          {detail !== "" && (each.efforts
            ? <button type="button" className="host-model-detail" aria-expanded={efforts === row} aria-label={t("Reasoning effort for {model}", { model: each.name })} onClick={() => setEfforts((open) => open === row ? null : row)}>{detail}<ChevronDown className="host-model-detail-caret" aria-hidden="true" /></button>
            : <span className="host-model-detail">{detail}</span>)}
          {efforts === row && each.efforts && <div className="host-picker-chips" role="group" aria-label={t("Reasoning effort")}>
            {each.efforts.values.map((value) => <button key={value} type="button" className={`host-picker-chip${picked && model?.effort === value ? " is-picked" : ""}`} aria-pressed={picked && model?.effort === value} data-effort={value}
              onClick={() => { setEfforts(null); pick({ id: each.id, effort: value }); }}>{value}</button>)}
          </div>}
        </div>;
      })}
    </section>)}
  </>;
}

function AgentList({ agents, agent, onAgent }: Pick<ModelPickerProps, "agents" | "agent" | "onAgent">) {
  const t = useT();
  const [query, setQuery] = useState("");
  const all = agents ?? [];
  const words = query.trim().toLowerCase();
  const shown = words === "" ? all : all.filter((each) => each.name.toLowerCase().includes(words) || (each.description ?? "").toLowerCase().includes(words));
  return <>
    {all.length > AGENT_SEARCH_FROM && <label className="host-picker-search">
      <Search aria-hidden="true" />
      <input className="input" type="search" value={query} placeholder={t("Search agents")} aria-label={t("Search agents")} onChange={(event) => setQuery(event.target.value)} />
    </label>}
    <div className="host-picker-group">
      <button type="button" className={`host-picker-option${agent === null ? " is-picked" : ""}`} aria-pressed={agent === null} data-agent="" onClick={() => onAgent(null)}>
        <span className="host-picker-option-name">{t("Agent")}</span>
        {agent === null && <Check className="host-picker-check" aria-hidden="true" />}
      </button>
      {shown.map((each) => {
        const picked = each.uri === agent;
        return <button key={each.uri} type="button" className={`host-picker-option${picked ? " is-picked" : ""}`} aria-pressed={picked} data-agent={each.uri} onClick={() => onAgent(each.uri)}>
          <span className="host-picker-option-name">{each.name}</span>
          {each.description && <span className="host-picker-option-id">{each.description}</span>}
          {picked && <Check className="host-picker-check" aria-hidden="true" />}
        </button>;
      })}
    </div>
    <p className="host-picker-note">{t("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.")}</p>
  </>;
}

function ModeList({ config, onConfig }: Pick<ModelPickerProps, "config" | "onConfig">) {
  const t = useT();
  if (config === null) return <p className="host-picker-state" role="status">{t("Loading…")}</p>;
  if (config.modes.length === 0 && config.approvalModes.length === 0) return <p className="host-picker-state">{t("This chat's host has no modes to pick")}</p>;
  return <>
    {config.modes.length > 0 && <section className="host-picker-group" aria-label={t("Agent mode")}>
      <p className="host-picker-provider">{t("Agent mode")}</p>
      {config.modes.map((each) => <button key={each} type="button" className={`host-picker-option${config.mode === each ? " is-picked" : ""}`} aria-pressed={config.mode === each} data-mode={each} onClick={() => onConfig({ mode: each })}>
        <span className="host-picker-option-name">{t(MODE_LABEL[each] ?? each)}</span>
        {config.mode === each && <Check className="host-picker-check" aria-hidden="true" />}
      </button>)}
    </section>}
    {config.approvalModes.length > 0 && <section className="host-picker-group" aria-label={t("Permissions")}>
      <p className="host-picker-provider">{t("Permissions")}</p>
      {config.approvalModes.map((each) => <button key={each} type="button" className={`host-picker-option${config.approvals === each ? " is-picked" : ""}`} aria-pressed={config.approvals === each} data-approvals={each} onClick={() => onConfig({ approvals: each })}>
        <span className="host-picker-option-name">{t(APPROVALS_LABEL[each] ?? each)}</span>
        {APPROVALS_HINT[each] && <span className="host-picker-option-id">{t(APPROVALS_HINT[each])}</span>}
        {config.approvals === each && <Check className="host-picker-check" aria-hidden="true" />}
      </button>)}
    </section>}
  </>;
}
