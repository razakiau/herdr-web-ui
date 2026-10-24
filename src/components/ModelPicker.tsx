/**
 * A host chat's pickers, as VS Code's model picker reads them (modelPickerTabs, Pinned and Recent,
 * one line per model with its mark and "High · 1M"), then the models by where they come from:
 * Copilot's catalogue with its premium-request rate, each router by vendor, the rest), its agent picker
 * ("Agent" first, then the host's custom agents), and the chat's mode and permissions
 * (agentHostModePickerPresentation.ts: Interactive / Plan / Autopilot, Manual / Assisted / Allow all).
 * Two sheets (ZAC-207 redesign): the model's, and the chat's settings (permissions, mode, agent),
 * each a grouped list with a checkmark on the choice. A sheet on a phone, a dialog on a desktop. The model and agent are the next message's (a pick is
 * carried by every send); the mode and permissions are the chat's, written once to its host.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Boxes, Check, ChevronDown, Hand, ListChecks, MessageSquare, Pin, Rocket, Scale, Search, ShieldCheck, Sparkles, TriangleAlert, X, type LucideIcon } from "lucide-react";

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
/** one line under each mode in the settings sheet */
const MODE_HINT: Record<string, string> = {
  interactive: "Asks and answers as you go",
  plan: "Plans before it changes anything",
  autopilot: "Works through the task on its own",
};
const MODE_ICON: Record<string, LucideIcon> = { interactive: MessageSquare, plan: ListChecks, autopilot: Rocket };
const APPROVALS_ICON: Record<string, LucideIcon> = { default: Hand, assisted: Scale, autoApprove: ShieldCheck };
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
  focus: "model" | "settings";
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

  const title = focus === "model" ? t("Model") : t("Chat settings");
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
          {focus === "settings" && <SettingsList config={config} agents={agents} agent={agent} onConfig={onConfig} onAgent={onAgent} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModelList({ machineId, models, model, onModel }: Pick<ModelPickerProps, "machineId" | "models" | "model" | "onModel">) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [pinned, setPinned] = useState(() => pinnedModels(machineId));
  const [recent] = useState(() => recentModels(machineId));
  const [efforts, setEfforts] = useState<string | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  if (models === null) return <p className="host-picker-state" role="status">{t("Loading…")}</p>;
  if (models.length === 0) return <p className="host-picker-state">{t("Copilot on this PC offers no models")}</p>;
  // the owner's ask (ZAC-207): with many models, narrow to one source (Copilot, OmniRoute…), each
  // chip carrying that source's mark; none when the PC offers one source only
  const sources = modelTabs(models);
  const shown = filterModels(models, query, source);
  // a search or a source keeps the groups but drops Pinned and Recent, which would only repeat its matches
  const searching = query.trim() !== "" || source !== null;
  const sections = pickerSections(shown, searching ? [] : pinned, searching ? [] : recent);
  // Pinned, Recent and the two groups the app names are words; a router's name is its id prefix
  const word = (key: string, title: string): string => (SECTION_TITLES as readonly string[]).includes(title) && ["pinned", "recent", "copilot", "other"].includes(key) ? t(title) : title;
  const heading = (section: PickerSection): string => word(section.key.split("\n")[0] ?? "", section.title);
  const pick = (next: { id: string; effort?: string }): void => { rememberRecent(machineId, next.id); onModel(next); };
  return <>
    {/* the search stays at the top while a long list scrolls under it; the captions name the providers */}
    <div className="host-picker-head">
    <label className="host-picker-search">
      <Search aria-hidden="true" />
      <input className="input" type="search" value={query} placeholder={t("Search models")} aria-label={t("Search models")} autoFocus onChange={(event) => setQuery(event.target.value)} />
    </label>
    {sources.length > 0 && <div className="host-picker-sources" role="group" aria-label={t("Sources")}>
      {[null, ...sources].map((each) => <button key={each ?? ""} type="button" className={`host-picker-chip host-picker-source${source === each ? " is-picked" : ""}`} aria-pressed={source === each} data-group={each ?? ""}
        onClick={() => setSource(each)}>
        {each !== null && (each === "other" ? <Boxes className="host-picker-source-icon" aria-hidden="true" /> : <span aria-hidden="true" className="host-picker-source-mark"><AgentMark agent={each} size={14} /></span>)}
        {each === null ? t("All") : word(each, groupName(each))}
        <span className="host-picker-source-count" aria-hidden="true">{each === null ? models.length : models.filter((model) => modelGroupOf(model) === each).length}</span>
      </button>)}
    </div>}
    </div>
    {shown.length === 0 && <p className="host-picker-state">{t("No models match")}</p>}
    {sections.map((section) => <section key={section.key} className="host-picker-group" aria-label={section.vendor ? `${heading(section)} · ${section.vendor}` : heading(section)}>
      <p className="host-picker-provider">{heading(section)}{section.vendor && <span className="host-picker-vendor"> · {section.vendor}</span>}</p>
      <div className="host-picker-rows">
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
      </div>
    </section>)}
  </>;
}

function SettingsList({ config, agents, agent, onConfig, onAgent }: Pick<ModelPickerProps, "config" | "agents" | "agent" | "onConfig" | "onAgent">) {
  const t = useT();
  const [query, setQuery] = useState("");
  const all = agents ?? [];
  const words = query.trim().toLowerCase();
  const shown = words === "" ? all : all.filter((each) => each.name.toLowerCase().includes(words) || (each.description ?? "").toLowerCase().includes(words));
  const option = (props: { key: string; data: Record<string, string>; picked: boolean; name: string; line?: string | undefined; Icon?: LucideIcon | undefined; tone?: string | undefined; onPick(): void }) =>
    <button key={props.key} type="button" className={`host-picker-option${props.picked ? " is-picked" : ""}`} aria-pressed={props.picked} {...props.data} onClick={props.onPick}>
      {props.Icon && <props.Icon className="host-picker-option-icon" data-tone={props.tone} aria-hidden="true" />}
      <span className="host-picker-option-text">
        <span className="host-picker-option-name">{props.name}</span>
        {props.line && <span className="host-picker-option-id">{props.line}</span>}
      </span>
      {props.picked && <Check className="host-picker-check" aria-hidden="true" />}
    </button>;
  return <>
    {config === null && <p className="host-picker-state" role="status">{t("Loading…")}</p>}
    {config !== null && config.approvalModes.length > 0 && <section className="host-picker-group" aria-label={t("Permissions")}>
      <p className="host-picker-provider">{t("Permissions")}</p>
      <div className="host-picker-rows">{config.approvalModes.map((each) => option({ key: each, data: { "data-approvals": each }, picked: config.approvals === each, name: t(APPROVALS_LABEL[each] ?? each),
        line: APPROVALS_HINT[each] ? t(APPROVALS_HINT[each]) : undefined, Icon: APPROVALS_ICON[each], tone: each === "autoApprove" ? "notice" : undefined, onPick: () => onConfig({ approvals: each }) }))}</div>
    </section>}
    {config !== null && config.modes.length > 0 && <section className="host-picker-group" aria-label={t("Mode")}>
      <p className="host-picker-provider">{t("Mode")}</p>
      <div className="host-picker-rows">{config.modes.map((each) => option({ key: each, data: { "data-mode": each }, picked: config.mode === each, name: t(MODE_LABEL[each] ?? each),
        line: MODE_HINT[each] ? t(MODE_HINT[each]) : undefined, Icon: MODE_ICON[each], onPick: () => onConfig({ mode: each }) }))}</div>
    </section>}
    <section className="host-picker-group" aria-label={t("Agent")}>
      <p className="host-picker-provider">{t("Agent")}</p>
      <div className="host-picker-rows">
      {all.length > AGENT_SEARCH_FROM && <label className="host-picker-search">
        <Search aria-hidden="true" />
        <input className="input" type="search" value={query} placeholder={t("Search agents")} aria-label={t("Search agents")} onChange={(event) => setQuery(event.target.value)} />
      </label>}
      {option({ key: "", data: { "data-agent": "" }, picked: agent === null, name: t("Agent"), onPick: () => onAgent(null) })}
      {shown.map((each) => option({ key: each.uri, data: { "data-agent": each.uri }, picked: each.uri === agent, name: each.name, line: each.description ?? undefined, onPick: () => onAgent(each.uri) }))}
      </div>
    </section>
    <p className="host-picker-note">{t("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.")}</p>
  </>;
}
