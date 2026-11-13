import { useState } from "react";
import { Check, ChevronDown, Circle, CircleCheck, CircleDot, CirclePause, CircleX, Clock, ListChecks, Scale, Target, TriangleAlert, Wallet, X, type LucideIcon } from "lucide-react";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import type { HostTodo } from "../../shared/host-chats.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { capDollars, dollars, goalHead } from "../lib/hostGoals.ts";
import { useT } from "../lib/i18n.ts";
import { currentTodo } from "../lib/todos.ts";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import "./HostTodoBar.css";

const ICON: Record<HostTodo["status"], LucideIcon> = { done: Check, in_progress: CircleDot, pending: Circle, blocked: TriangleAlert };

/**
 * VS Code's todo list above the input (chat.todoListWidget), drawn as a tab tucked under the
 * composer's top edge (the Composer's `tray`) so it reads as part of it: closed, how many are done,
 * a short meter and the task the agent is on; open, every todo with its state. Gone when there is none,
 * and once all are done and the chat is idle. The list starts over at each message, as VS Code's does
 * (the server cuts it: server/agent-host/todos.ts todosSince), so it no longer grows for ever (ZAC-233).
 *
 * A chat's goal (ZAC-326) takes over the head: its spend against the cap and what it is on; open, the
 * todos come first, then the goal's terms and the judge's checks. One tab rather than two, which would
 * be the sandwich ZAC-228 removed. An ended goal can be dismissed, remembered per goal under `dismissKey`.
 */
export function HostTodoBar({ todos, busy, defaultOpen = false, goal = null, dismissKey }: {
  todos: readonly HostTodo[] | undefined; busy: boolean; defaultOpen?: boolean; goal?: GoalView | null; dismissKey?: string;
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

  // a met goal opens to its summary
  const open = chosen ?? (defaultOpen || goal.status === "met");
  const head = goalHead(goal, todos, Date.now());
  const Icon = goal.status === "active" ? Target : goal.status === "met" ? CircleCheck : goal.status === "stopped" ? CircleX : CirclePause;
  const done = listed === null ? 0 : doneOf(listed);
  return <section className="todo-bar goal-bar">
    <div className="goal-bar-head">
      <button type="button" className="todo-bar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon className="todo-bar-icon" aria-hidden="true" />
        <span className="todo-bar-title">{head.title}</span>
        <span className="todo-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={goal.capUsd} aria-valuenow={Math.min(goal.spentUsd, goal.capUsd)}>
          <span className="todo-bar-fill" data-tone={head.tone} style={{ width: spendShare(goal.spentUsd, goal.capUsd) }} />
        </span>
        <span className="todo-bar-current">{head.current}</span>
        <ChevronDown className="todo-bar-caret" aria-hidden="true" />
      </button>
      {ended && dismissal !== null && <button type="button" className="goal-bar-dismiss" aria-label={t("Dismiss goal")} title={t("Dismiss goal")} onClick={() => {
        dismiss(dismissal);
        setDismissed((count) => count + 1);
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
          <p className="goal-bar-section"><Target className="todo-bar-row-icon" aria-hidden="true" /><span>{t("Goal")}</span></p>
        </>}
        <ol className="todo-bar-list">
          <GoalRow icon={Target} status="pending" text={t("Goal: {objective}", { objective: goal.objective })} />
          <GoalRow icon={goal.status === "met" ? Check : Circle} status={goal.status === "met" ? "met" : "pending"} text={t("Done when: {doneWhen}", { doneWhen: goal.doneWhen })} />
          <GoalRow icon={Scale} status={goal.judge.warning === null ? "pending" : "blocked"}
            text={goal.judge.warning === null ? t("Judge {model}", { model: goal.judge.model }) : t("Judge {model} · same family", { model: goal.judge.model })} />
          <GoalRow icon={Clock} status="pending" text={goal.away === "assume" ? t("While you're away: takes its recommended answer") : t("While you're away: waits for you")} />
          {goal.judge.checks.map((check, index) => <GoalRow key={check.at + index} icon={CHECK_ICON[check.verdict]} status={check.verdict} text={checkText(t, index + 1, check)} />)}
          <GoalRow icon={Wallet} status={goal.status === "met" ? "met" : "pending"}
            text={t("Chat {chat} · judge {judge} · cap {cap}", { chat: dollars(goal.chatUsd), judge: dollars(goal.judgeUsd), cap: capDollars(goal.capUsd) })} />
        </ol>
      </>}
    </AnimatedHeight>
  </section>;
}

const CHECK_ICON: Record<GoalCheck["verdict"], LucideIcon> = { met: Check, not_met: CircleX, impossible: CircleX, error: TriangleAlert };

function checkText(t: ReturnType<typeof useT>, n: number, check: GoalCheck): string {
  const reason = check.reason;
  switch (check.verdict) {
    case "met": return t("Check {n} · met: {reason}", { n, reason });
    case "not_met": return t("Check {n} · not met: {reason}", { n, reason });
    case "impossible": return t("Check {n} · impossible: {reason}", { n, reason });
    case "error": return t("Check {n} · error: {reason}", { n, reason });
  }
}

function TodoRows({ todos }: { todos: readonly HostTodo[] }) {
  return todos.map((todo) => <GoalRow key={todo.id} icon={ICON[todo.status]} status={todo.status} text={todo.title} />);
}

function GoalRow({ icon: Icon, status, text }: { icon: LucideIcon; status: string; text: string }) {
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
