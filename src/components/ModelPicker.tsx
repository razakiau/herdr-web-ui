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
import { Boxes, Check, ChevronDown, Clock, Hand, ListChecks, MessageSquare, Pin, Rocket, Scale, ShieldCheck, Sparkles, Target, TriangleAlert, X, type LucideIcon } from "lucide-react";

import type { JudgeChoice } from "../../shared/goal-budget.ts";
import type { GoalView } from "../../shared/goals.ts";
import type { HostAgent, HostModel, HostSessionConfig } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { filterModels, groupName, modelGroupOf, modelTabs, multiplierLabel, pickerSections, pinnedModels, providerMark, recentModels, rememberRecent, rowDetail, SECTION_TITLES, togglePinned, type ModelMark, type PickerSection } from "../lib/modelProvider.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { AgentMark } from "./AgentMark.tsx";
import { formatTokenCount } from "./HostChatStatus.tsx";
import { SearchField } from "./SearchField.tsx";
import { formatUsd } from "../lib/chatCost.ts";

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
/** the goal's caps on offer, $25 picked first */
const BUDGETS = [10, 25, 50, 100] as const;
const DEFAULT_BUDGET = 25;
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
  /**
   * What switching to a model stores again (ZAC-260 phase 2): the chat's context and its price on
   * that model, null for no line (the same model, still warm, a small chat, no costs).
   */
  switchCost?: ((model: string) => { tokens: number; usd: number } | null) | undefined;
  onAgent(agent: string | null): void;
  onConfig(change: { mode?: string; approvals?: string }): void;
  /** the chat's goal (ZAC-326), null when it has none */
  goal: GoalView | null;
  /** the objective a goal started now would get: the chat's newest message, null before the first */
  goalDraft: string | null;
  /** the judges to offer, null while they load */
  judges: JudgeChoice[] | null;
  /** starts the goal; resolves to the server's error code, or null once it runs */
  onStartGoal(input: GoalStart): Promise<string | null>;
  onStopGoal(): Promise<void>;
  onClose(): void;
}

/** What the settings sheet's Goal form starts a goal with. */
export interface GoalStart { doneWhen: string; capUsd: number; judgeModel: string | null; away: "assume" | "wait"; allowUnpriced: boolean }

export function ModelPicker({ machineId, focus, models, agents, model, agent, config, error, onModel, switchCost, onAgent, onConfig, goal, goalDraft, judges, onStartGoal, onStopGoal, onClose }: ModelPickerProps) {
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
        {focus === "model" && <div className="modal-body host-picker-body">
          {error !== null && <p className="host-picker-error" role="alert">{error}</p>}
          <ModelList machineId={machineId} models={models} model={model} onModel={onModel} switchCost={switchCost} />
        </div>}
        {focus === "settings" && <SettingsList config={config} agents={agents} agent={agent} models={models} error={error} onConfig={onConfig} onAgent={onAgent}
          goal={goal} goalDraft={goalDraft} judges={judges} onStartGoal={onStartGoal} onStopGoal={onStopGoal} onClose={onClose} />}
      </div>
    </div>,
    document.body,
  );
}

function ModelList({ machineId, models, model, onModel, switchCost }: Pick<ModelPickerProps, "machineId" | "models" | "model" | "onModel" | "switchCost">) {
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
    <SearchField className="host-picker-search" value={query} onValue={setQuery} label={t("Search models")} placeholder={t("Search models")} autoFocus />
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
        // a quiet line, no modal: the next call on this model stores the chat again (owner, ZAC-260)
        const restart = picked ? null : switchCost?.(each.id) ?? null;
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
          {restart !== null && <p className="host-model-restart" data-restart={each.id}>{t("Switching stores {n} again ~{usd}", { n: formatTokenCount(restart.tokens), usd: formatUsd(restart.usd) })}</p>}
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

type SettingsListProps = Pick<ModelPickerProps, "config" | "agents" | "agent" | "models" | "error" | "onConfig" | "onAgent" | "goal" | "goalDraft" | "judges" | "onStartGoal" | "onStopGoal" | "onClose">;

/** The settings sheet's body, and its footer while the Goal form is open or a goal runs. */
export function SettingsList({ config, agents, agent, models, error, onConfig, onAgent, goal, goalDraft, judges, onStartGoal, onStopGoal, onClose }: SettingsListProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const all = agents ?? [];
  const words = query.trim().toLowerCase();
  const shown = words === "" ? all : all.filter((each) => each.name.toLowerCase().includes(words) || (each.description ?? "").toLowerCase().includes(words));
  // a paused goal is still the chat's: it is stopped from here, not started again
  const running = goal !== null && (goal.status === "active" || goal.status === "paused" || goal.status === "budget_limited");
  const [goalOpen, setGoalOpen] = useState(false);
  const [doneWhen, setDoneWhen] = useState("");
  const [budget, setBudget] = useState<number | "other">(DEFAULT_BUDGET);
  const [otherBudget, setOtherBudget] = useState("");
  // null: the first judge on offer, the server's default
  const [judge, setJudge] = useState<string | null>(null);
  const [away, setAway] = useState<"assume" | "wait">("assume");
  const [unpriced, setUnpriced] = useState(false);
  const [busy, setBusy] = useState(false);
  const goalPicked = running || goalOpen;
  const pickedJudge = judge ?? judges?.[0]?.id ?? null;
  const capUsd = budget === "other" ? Number(otherBudget) : budget;
  const canStart = !busy && doneWhen.trim() !== "" && Number.isFinite(capUsd) && capUsd > 0;
  const start = (allowUnpriced: boolean): void => {
    setBusy(true);
    void onStartGoal({ doneWhen: doneWhen.trim(), capUsd, judgeModel: pickedJudge, away, allowUnpriced }).then((code) => {
      setBusy(false);
      setUnpriced(code === "unpriced_model");
    }, () => setBusy(false));
  };
  const stop = (): void => {
    setBusy(true);
    void onStopGoal().finally(() => setBusy(false));
  };
  const option = (props: { key: string; data: Record<string, string>; picked: boolean; name: string; line?: string | undefined; Icon?: LucideIcon | undefined; mark?: ModelMark | undefined; tone?: string | undefined; disabled?: boolean; onPick(): void }) =>
    <button key={props.key} type="button" className={`host-picker-option${props.picked ? " is-picked" : ""}`} aria-pressed={props.picked} disabled={props.disabled} {...props.data} onClick={props.onPick}>
      {props.Icon && <props.Icon className="host-picker-option-icon" data-tone={props.tone} aria-hidden="true" />}
      {props.mark && <span className="host-picker-option-icon host-picker-option-mark" aria-hidden="true"><ModelMarkIcon mark={props.mark} size={20} /></span>}
      <span className="host-picker-option-text">
        <span className="host-picker-option-name">{props.name}</span>
        {props.line && <span className="host-picker-option-id">{props.line}</span>}
      </span>
      {props.picked && <Check className="host-picker-check" aria-hidden="true" />}
    </button>;
  const judgeRow = (each: JudgeChoice) => {
    const entry = models?.find((model) => model.id === each.id);
    return option({ key: each.id, data: { "data-judge": each.id }, picked: each.id === pickedJudge, name: entry?.name ?? each.id, line: each.why === "default" ? t("Another family than the worker") : each.why === "cheapest" ? t("Cheapest · another family") : t("Same family as the worker: it may go easy on it"),
      mark: entry ? providerMark(entry) : undefined, onPick: () => { setJudge(each.id); setUnpriced(false); } });
  };
  const goalForm = goalOpen && !running && <>
    <section className="host-picker-group" aria-label={t("Done when")}>
      <p className="host-picker-provider">{t("Done when")}</p>
      <textarea className="input host-picker-goal-done" rows={3} aria-label={t("Done when")} value={doneWhen} onChange={(event) => setDoneWhen(event.target.value)} />
      <p className="host-picker-note">{t("The judge only reads the chat, so name proof it can see: a command and its output.")}</p>
    </section>
    <section className="host-picker-group" aria-label={t("Budget")}>
      <p className="host-picker-provider">{t("Budget")}</p>
      <div className="host-picker-chips">
        {BUDGETS.map((each) => <button key={each} type="button" className={`host-picker-chip${budget === each ? " is-picked" : ""}`} aria-pressed={budget === each} data-budget={each}
          onClick={() => setBudget(each)}>{`$${each}`}</button>)}
        <button type="button" className={`host-picker-chip${budget === "other" ? " is-picked" : ""}`} aria-pressed={budget === "other"} data-budget="other" onClick={() => setBudget("other")}>{t("Other…")}</button>
      </div>
      {budget === "other" && <label className="host-picker-goal-other">
        <span aria-hidden="true">$</span>
        <input className="input" type="number" inputMode="decimal" min="0" step="any" aria-label={t("Budget in dollars")} value={otherBudget} onChange={(event) => setOtherBudget(event.target.value)} />
      </label>}
      <p className="host-picker-note">{t("At API prices, from OmniRoute's log. It pauses at the cap and asks before spending more.")}</p>
    </section>
    {/* none on offer (the list could not be read): the server takes its default judge */}
    {judges?.length !== 0 && <section className="host-picker-group" aria-label={t("Judge")}>
      <p className="host-picker-provider">{t("Judge")}</p>
      {judges === null ? <p className="host-picker-state" role="status">{t("Loading…")}</p> : <div className="host-picker-rows">{judges.map(judgeRow)}</div>}
    </section>}
    <section className="host-picker-group" aria-label={t("While you're away")}>
      <p className="host-picker-provider">{t("While you're away")}</p>
      <div className="host-picker-rows">
        {option({ key: "assume", data: { "data-away": "assume" }, picked: away === "assume", name: t("Take its recommended answer"),
          line: t("Only for questions it marks optional, after 1 min with no Ovis open. Blocking ones wait."), Icon: Clock, onPick: () => setAway("assume") })}
        {option({ key: "wait", data: { "data-away": "wait" }, picked: away === "wait", name: t("Wait for me"), line: t("Every question waits until you answer"), Icon: Hand, onPick: () => setAway("wait") })}
      </div>
    </section>
    {unpriced && <p className="host-picker-error" role="alert">{t("This model has no price, so the cap can't count its spend.")}</p>}
  </>;
  return <>
    <div className="modal-body host-picker-body">
    {error !== null && <p className="host-picker-error" role="alert">{error}</p>}
    {config === null && <p className="host-picker-state" role="status">{t("Loading…")}</p>}
    {config !== null && config.approvalModes.length > 0 && <section className="host-picker-group" aria-label={t("Permissions")}>
      <p className="host-picker-provider">{t("Permissions")}</p>
      <div className="host-picker-rows">{config.approvalModes.map((each) => option({ key: each, data: { "data-approvals": each }, picked: config.approvals === each, name: t(APPROVALS_LABEL[each] ?? each),
        line: APPROVALS_HINT[each] ? t(APPROVALS_HINT[each]) : undefined, Icon: APPROVALS_ICON[each], tone: each === "autoApprove" ? "notice" : undefined, onPick: () => onConfig({ approvals: each }) }))}</div>
    </section>}
    {/* a goal runs on top of the chat's mode (ZAC-326): its row is one more in the group, the host's mode stays as it is */}
    {config !== null && <section className="host-picker-group" aria-label={t("Mode")}>
      <p className="host-picker-provider">{t("Mode")}</p>
      <div className="host-picker-rows">{config.modes.map((each) => option({ key: each, data: { "data-mode": each }, picked: config.mode === each, name: t(MODE_LABEL[each] ?? each),
        line: MODE_HINT[each] ? t(MODE_HINT[each]) : undefined, Icon: MODE_ICON[each], onPick: () => onConfig({ mode: each }) }))}
        {option({ key: "goal", data: { "data-mode": "goal" }, picked: goalPicked, name: t("Goal"), Icon: Target, disabled: !running && goalDraft === null,
          line: !running && goalDraft === null ? t("Send the first message, then start a goal") : t("Works until a judge agrees it's done"), onPick: () => { if (running) return; if (!goalOpen) setDoneWhen(goalDraft ?? ""); setGoalOpen(true); } })}
      </div>
    </section>}
    {goalForm}
    <section className="host-picker-group" aria-label={t("Agent")}>
      <p className="host-picker-provider">{t("Agent")}</p>
      <div className="host-picker-rows">
      {all.length > AGENT_SEARCH_FROM && <SearchField className="host-picker-search" value={query} onValue={setQuery} label={t("Search agents")} placeholder={t("Search agents")} />}
      {option({ key: "", data: { "data-agent": "" }, picked: agent === null, name: t("Agent"), onPick: () => onAgent(null) })}
      {shown.map((each) => option({ key: each.uri, data: { "data-agent": each.uri }, picked: each.uri === agent, name: each.name, line: each.description ?? undefined, onPick: () => onAgent(each.uri) }))}
      </div>
    </section>
    <p className="host-picker-note">{t("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.")}</p>
    </div>
    {goalPicked && <footer className="modal-footer">
      <button type="button" className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
      {running
        ? <button type="button" className="btn btn-danger" disabled={busy} onClick={stop}>{t("Stop goal")}</button>
        : <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => start(unpriced)}>{unpriced ? t("Start anyway") : t("Start goal")}</button>}
    </footer>}
  </>;
}
