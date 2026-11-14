import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, CirclePause, CircleX, ListChecks, Pause, Play, Target, TriangleAlert, X, type LucideIcon } from "lucide-react";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import type { HostTodo } from "../../shared/host-chats.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { errorText } from "../lib/hostChats.ts";
import { capDollars, dollars, goalHead, pauseGoal, pauseReasonWords, raiseGoal, resumeGoal, stopGoal, type GoalRing } from "../lib/hostGoals.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { currentTodo } from "../lib/todos.ts";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import { digestModelName } from "./DigestCard.tsx";
import "./HostTodoBar.css";

const ICON: Record<HostTodo["status"], LucideIcon> = { done: Check, in_progress: CircleDot, pending: Circle, blocked: TriangleAlert };

/**
 * VS Code's todo list above the input (chat.todoListWidget), drawn as a tab tucked under the
 * composer's top edge (the Composer's `tray`) so it reads as part of it: closed, how many are done,
 * a short meter and the task the agent is on; open, every todo with its state. Gone when there is none,
 * and once all are done and the chat is idle. The list starts over at each message, as VS Code's does
 * (the server cuts it: server/agent-host/todos.ts todosSince), so it no longer grows for ever (ZAC-233).
 *
 * A chat's goal (ZAC-326) takes over the head (GoalBar): its state, its spend against the cap and what
 * it is on; open, the todos come first, then the goal. One tab rather than two, which would be the
 * sandwich ZAC-228 removed. With `machineId` and `session` it pauses, resumes, raises and stops the
 * goal itself (then `onGoalChanged`), and a stopped one offers `onStartAgain`. An ended goal can be
 * dismissed, remembered per goal under `dismissKey`.
 */
export function HostTodoBar({ todos, busy, defaultOpen = false, goal = null, dismissKey, machineId, session, onGoalChanged, onStartAgain }: {
  todos: readonly HostTodo[] | undefined; busy: boolean; defaultOpen?: boolean; goal?: GoalView | null; dismissKey?: string;
  machineId?: string; session?: string; onGoalChanged?: () => void; onStartAgain?: (goal: GoalView) => void;
}) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle("host-todos", null);
  const [, setDismissed] = useState(0);
  const listed = todos !== undefined && todos.length > 0 && !(todos.every((todo) => todo.status === "done") && !busy) ? todos : null;
  const ended = goal !== null && (goal.status === "met" || goal.status === "stopped");
  const dismissal = goal !== null && dismissKey !== undefined ? `ovis.goal-dismissed:${dismissKey}:${goal.startedAt}` : null;
  if (goal === null || (ended && dismissal !== null && wasDismissed(dismissal))) {
    if (listed === null) return null;
    const open = chosen ?? defaultOpen;
    const done = doneOf(listed);
    const current = currentTodo(listed);
    return <section className="todo-bar">
      <button type="button" className="todo-bar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListChecks className="todo-bar-icon" aria-hidden="true" />
        <span className="todo-bar-title">{t("Todos {done}/{total}", { done, total: listed.length })}</span>
        <span className="todo-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={listed.length} aria-valuenow={done}>
          <span className="todo-bar-fill" style={{ width: shareOf(done, listed.length) }} />
        </span>
        {current !== null && <span className="todo-bar-current">{current.title}</span>}
        <ChevronDown className="todo-bar-caret" aria-hidden="true" />
      </button>
      <AnimatedHeight open={open}>
        {open && <ol className="todo-bar-list"><TodoRows todos={listed} /></ol>}
      </AnimatedHeight>
    </section>;
  }

  return <GoalBar goal={goal} todos={todos} listed={listed} open={chosen ?? (defaultOpen || paused(goal))} setOpen={setOpen} dismissal={ended ? dismissal : null}
    onDismiss={() => setDismissed((count) => count + 1)} actions={machineId !== undefined && session !== undefined ? { machineId, session, onChanged: onGoalChanged, onStartAgain } : null} />;
}

interface GoalActions { machineId: string; session: string; onChanged?: (() => void) | undefined; onStartAgain?: ((goal: GoalView) => void) | undefined }

const RING: Record<GoalRing, LucideIcon> = { run: Target, pause: CirclePause, met: CircleCheck, stop: CircleX };
const paused = (goal: GoalView): boolean => goal.status === "paused" || goal.status === "budget_limited";

/**
 * The goal's tab (ZAC-326): the head is its state, its spend against the cap and what it is on, with
 * a pause or resume beside it. Open, the agent's todos first, then the objective, the done-when (two
 * lines, a tap shows it whole), the card that matters now (the latest check, or why it paused or
 * stopped with what to do about it), the older checks folded, and one line of judge, away rule and spend.
 */
function GoalBar({ goal, todos, listed, open, setOpen, dismissal, onDismiss, actions }: {
  goal: GoalView; todos: readonly HostTodo[] | undefined; listed: readonly HostTodo[] | null; open: boolean; setOpen(open: boolean | null): void;
  dismissal: string | null; onDismiss(): void; actions: GoalActions | null;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // a goal that pauses asks for something (a raise, a resume): its tab opens to it, whatever was picked before
  const wasPaused = useRef(paused(goal));
  useEffect(() => {
    const now = paused(goal);
    if (now && !wasPaused.current) setOpen(true);
    wasPaused.current = now;
  }, [goal, setOpen]);
  const head = goalHead(goal, todos, Date.now());
  const Ring = RING[head.ring];
  const done = listed === null ? 0 : doneOf(listed);
  const run = (action: (machine: string, session: string) => Promise<GoalView>): void => {
    if (actions === null || busy) return;
    setBusy(true);
    setFailure(null);
    void action(actions.machineId, actions.session).then(() => { setBusy(false); actions.onChanged?.(); }, (cause: unknown) => {
      setBusy(false);
      setFailure(errorText(cause));
    });
  };
  const headAction = actions === null ? null
    : goal.status === "active" ? <button type="button" className="goal-bar-act" aria-label={t("Pause goal")} title={t("Pause goal")} disabled={busy} onClick={() => run(pauseGoal)}><Pause aria-hidden="true" /></button>
    : goal.status === "paused" ? <button type="button" className="goal-bar-act" data-tone="notice" aria-label={t("Resume goal")} title={t("Resume goal")} disabled={busy} onClick={() => run(resumeGoal)}><Play aria-hidden="true" /></button>
    : null;
  return <section className="todo-bar goal-bar" data-status={goal.status}>
    <div className="goal-bar-head">
      <button type="button" className="todo-bar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ring className="todo-bar-icon goal-bar-ring" data-tone={head.tone} aria-hidden="true" />
        <span className="todo-bar-title">{head.title}</span>
        <span className="goal-bar-spend">{head.spent}<span className="goal-bar-cap"> / {head.cap}</span></span>
        <span className="todo-bar-track" role="progressbar" aria-label={t("Spent of the cap")} aria-valuemin={0} aria-valuemax={goal.capUsd} aria-valuenow={Math.min(goal.spentUsd, goal.capUsd)}>
          <span className="todo-bar-fill" data-tone={head.tone} style={{ width: spendShare(goal.spentUsd, goal.capUsd) }} />
        </span>
        <span className="todo-bar-current">{head.current}</span>
        <ChevronDown className="todo-bar-caret" aria-hidden="true" />
      </button>
      {headAction}
      {dismissal !== null && <button type="button" className="goal-bar-act" aria-label={t("Dismiss goal")} title={t("Dismiss goal")} onClick={() => {
        dismiss(dismissal);
        onDismiss();
      }}><X aria-hidden="true" /></button>}
    </div>
    <AnimatedHeight open={open}>
      {open && <>
        {listed !== null && <>
          <p className="goal-bar-section">
            <ListChecks className="todo-bar-row-icon" aria-hidden="true" />
            <span>{t("Todos {done}/{total}", { done, total: listed.length })}</span>
            <span className="todo-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={listed.length} aria-valuenow={done}>
              <span className="todo-bar-fill" style={{ width: shareOf(done, listed.length) }} />
            </span>
          </p>
          <ol className="todo-bar-list goal-bar-todos"><TodoRows todos={listed} /></ol>
        </>}
        <GoalBody goal={goal} busy={busy} failure={failure} run={actions === null ? null : run}
          onStartAgain={actions?.onStartAgain === undefined ? null : () => actions.onStartAgain?.(goal)} />
      </>}
    </AnimatedHeight>
  </section>;
}

function GoalBody({ goal, busy, failure, run, onStartAgain }: {
  goal: GoalView; busy: boolean; failure: string | null;
  run: ((action: (machine: string, session: string) => Promise<GoalView>) => void) | null; onStartAgain: (() => void) | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [whenOpen, setWhenOpen] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const checks = goal.judge.checks;
  const latest = checks.at(-1) ?? null;
  // the older checks, newest first; the latest is the card
  const earlier = checks.slice(0, -1).map((check, index) => ({ check, n: index + 1 })).reverse();
  // the goal keeps no pause time of its own: its last update is when it paused or stopped, unless a check landed after
  const at = { iso: goal.updatedAt, clock: clock(goal.updatedAt, locale) };
  const card = cardOf(goal, latest, checks.length, t);
  const button = (label: string, action: () => void, primary = false) =>
    <button key={label} type="button" className={`btn goal-card-btn${primary ? " btn-primary" : ""}`} disabled={busy} onClick={action}>{label}</button>;
  const buttons = run === null ? [] : goal.status === "budget_limited"
    ? [...(goal.raises ?? []).map((cap, index) => button(t("Raise to {cap}", { cap: capDollars(cap) }), () => run((machine, session) => raiseGoal(machine, session, cap)), index === 0)),
      button(t("Stop"), () => run(stopGoal))]
    : goal.status === "paused"
      ? [button(t("Resume"), () => run(resumeGoal), true), ...(goal.pauseReason === "owner" ? [] : [button(t("Stop"), () => run(stopGoal))])]
      : [];
  if (goal.status === "stopped" && onStartAgain !== null) buttons.push(button(t("Start again…"), onStartAgain, true));
  return <div className="goal-body">
    <h3 className="goal-obj">{goal.objective}</h3>
    <button type="button" className="goal-when" aria-expanded={whenOpen} onClick={() => setWhenOpen(!whenOpen)}>
      <span className="goal-when-k">{t("Done when")}</span> {goal.doneWhen}
    </button>
    {card !== null && <GoalCard card={card} at={at} actions={buttons} failure={failure} />}
    {earlier.length > 0 && <>
      <button type="button" className="goal-earlier" aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}>
        {earlierOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        {earlier.length === 1 ? t("1 earlier check") : t("{n} earlier checks", { n: earlier.length })}
      </button>
      {earlierOpen && <ol className="goal-earlier-list">
        {earlier.map(({ check, n }) => <li key={check.at + n} data-verdict={check.verdict}>
          <span className="goal-earlier-n">{n}</span>
          <span className="goal-earlier-t" title={check.reason}>{verdictWord(check.verdict, t)}: {check.reason}</span>
        </li>)}
      </ol>}
    </>}
    <p className="goal-meta">
      <span title={goal.judge.model}>{t("Judge {model}", { model: digestModelName(goal.judge.model) })}</span>
      {goal.judge.warning === "same_family" && <span className="goal-chip">{t("same family")}</span>}
      <span className="goal-dot" aria-hidden="true">·</span>
      <span>{goal.away === "assume" ? t("away: takes its pick") : t("away: waits for you")}</span>
      <span className="goal-dot" aria-hidden="true">·</span>
      <span>{t("chat {chat} · judge {judge}", { chat: dollars(goal.chatUsd), judge: dollars(goal.judgeUsd) })}</span>
    </p>
  </div>;
}

/**
 * The card under the done-when: what the goal needs now. `head`, `reason` (whole) and `text` (two
 * lines, a tap shows it whole) are its live region and depend only on the goal's state and its checks;
 * `time` (when it paused or stopped, as near as the goal says) sits outside it, so a write that only
 * moves the goal's update time announces nothing.
 */
interface Card { tone: "notice" | "blocked" | "done" | "ended"; Icon: LucideIcon; head: string; reason: string | null; text: string | null; time: boolean }

function cardOf(goal: GoalView, latest: GoalCheck | null, n: number, t: Translate): Card | null {
  const last = latest === null ? null : t("Last check: {reason}", { reason: latest.reason });
  if (goal.status === "budget_limited") return { tone: "notice", Icon: CirclePause, head: t("Hit the {cap} cap", { cap: capDollars(goal.capUsd) }), reason: null, text: last, time: false };
  if (goal.status === "paused") {
    if (goal.pauseReason === "owner") return { tone: "notice", Icon: CirclePause, head: t("Paused by you"), reason: null, text: last, time: true };
    // the runner's reason in full, then the last check; an impossible verdict's reason is the pause's, said once
    return { tone: "notice", Icon: CirclePause, head: t("Paused"), reason: pauseReasonWords(goal.pauseReason),
      text: latest !== null && latest.reason !== goal.pauseReason ? last : null, time: true };
  }
  if (goal.status === "stopped") return { tone: "ended", Icon: CircleX, head: t("Stopped by you"), reason: null, text: last, time: true };
  if (latest === null) return null;
  return {
    tone: latest.verdict === "met" ? "done" : latest.verdict === "error" ? "blocked" : "notice",
    Icon: CHECK_ICON[latest.verdict],
    head: t("Check {n} · {verdict}", { n, verdict: verdictWord(latest.verdict, t) }),
    reason: null, text: latest.reason, time: false,
  };
}

/** The card: its live region (head, reason, text), the time beside it, then its buttons and a refusal, outside it. */
function GoalCard({ card, at, actions, failure }: { card: Card; at: { iso: string; clock: string } | null; actions: ReactNode[]; failure: string | null }) {
  const [whole, setWhole] = useState(false);
  const { Icon } = card;
  const time = card.time && at !== null && at.clock !== "" ? at : null;
  return <div className="goal-card" data-tone={card.tone}>
    <div className="goal-card-live" role="status">
      <p className="goal-card-head"><Icon aria-hidden="true" /><span>{card.head}</span></p>
      {card.reason !== null && <p className="goal-card-reason">{card.reason}</p>}
      {card.text !== null && <button type="button" className="goal-card-text" aria-expanded={whole} onClick={() => setWhole(!whole)}>{card.text}</button>}
    </div>
    {time !== null && <time className="goal-card-time" dateTime={time.iso}>{time.clock}</time>}
    {actions.length > 0 && <div className="goal-card-actions">{actions}</div>}
    {failure !== null && <p className="goal-card-error" role="alert">{failure}</p>}
  </div>;
}

const CHECK_ICON: Record<GoalCheck["verdict"], LucideIcon> = { met: CircleCheck, not_met: CircleX, impossible: CircleX, error: TriangleAlert };

function verdictWord(verdict: GoalCheck["verdict"], t: Translate): string {
  switch (verdict) {
    case "met": return t("met");
    case "not_met": return t("not met");
    case "impossible": return t("impossible");
    case "error": return t("error");
  }
}

/** an ISO time as the hour and minute it was, here */
function clock(iso: string, locale: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function TodoRows({ todos }: { todos: readonly HostTodo[] }) {
  return todos.map((todo) => <TodoRow key={todo.id} icon={ICON[todo.status]} status={todo.status} text={todo.title} />);
}

function TodoRow({ icon: Icon, status, text }: { icon: LucideIcon; status: string; text: string }) {
  return <li className="todo-bar-row" data-status={status}>
    <Icon className="todo-bar-row-icon" aria-hidden="true" />
    <span className="todo-bar-row-title">{text}</span>
  </li>;
}

const doneOf = (todos: readonly HostTodo[]): number => todos.filter((todo) => todo.status === "done").length;
const shareOf = (part: number, whole: number): string => `${Math.round((part / whole) * 1000) / 10}%`;
/** the spend's share of the cap; a cap that is no number above 0 shows full once anything is spent, never NaN */
const spendShare = (spent: number, cap: number): string =>
  !Number.isFinite(cap) || cap <= 0 ? (spent > 0 ? "100%" : "0%") : shareOf(Math.min(spent, cap), cap);

// storage can be missing or refuse (private browsing): the goal then just stays
function wasDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function dismiss(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // nothing to remember it in
  }
}
