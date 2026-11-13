/**
 * A chat's goal (ZAC-326) as the central server runs it (server/goals/, /api/goals): the calls that
 * start, raise, stop and resume one, the hook a chat reads its goal with, the judge's check message
 * the runner sends into the chat, and the goal bar's head. Not OmO's goal tools (goals.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { HostTodo } from "../../shared/host-chats.ts";
import type { JudgeChoice } from "../../shared/goal-budget.ts";
import type { GoalView } from "../../shared/goals.ts";
import { getJson, sendJson } from "./api.ts";
import { onHostChatMessage, onHostChatResume } from "./hostChats.ts";
import { t } from "./i18n.ts";
import { currentTodo } from "./todos.ts";

/** How often a running goal is read again while no push comes. */
const ACTIVE_POLL_MS = 15_000;
/** The least time between two reads a chat's pushes make: a streaming turn pushes many times a second. */
const PUSH_GAP_MS = 2_000;

export async function fetchGoals(): Promise<GoalView[]> {
  return (await getJson<{ goals: GoalView[] }>("/api/goals", { cache: "no-store" })).goals;
}

export async function startGoal(body: { machine: string; session: string; objective: string; doneWhen: string; capUsd: number; judgeModel?: string; allowUnpriced?: boolean; away?: "assume" | "wait" }): Promise<GoalView> {
  return goalFrom(await sendJson("/api/goals/start", "POST", body));
}

export async function raiseGoal(machine: string, session: string, capUsd: number): Promise<GoalView> {
  return goalFrom(await sendJson("/api/goals/raise", "POST", { machine, session, capUsd }));
}

export async function stopGoal(machine: string, session: string): Promise<GoalView> {
  return goalFrom(await sendJson("/api/goals/stop", "POST", { machine, session }));
}

export async function resumeGoal(machine: string, session: string): Promise<GoalView> {
  return goalFrom(await sendJson("/api/goals/resume", "POST", { machine, session }));
}

/** The judges to offer a chat whose last model is `worker` (none known: null). */
export async function fetchJudges(worker: string | null): Promise<JudgeChoice[]> {
  const url = worker === null ? "/api/goals/judges" : `/api/goals/judges?worker=${encodeURIComponent(worker)}`;
  return (await getJson<{ choices: JudgeChoice[] }>(url, { cache: "no-store" })).choices;
}

async function goalFrom(response: Response): Promise<GoalView> {
  return ((await response.json()) as { goal: GoalView }).goal;
}

/**
 * The goal of `machineId`'s chat `session`, null when it has none. Read again on the chat's push (at
 * most once every 2 s, a push in between read at the gap's end), when the page or the event stream
 * comes back, every 15 s while it runs (the judge's spend moves with no push of the chat's own), and
 * on `refresh`. A failed read keeps what was shown.
 */
export function useHostGoal(machineId: string, session: string): { goal: GoalView | null; refresh(): void } {
  const [goal, setGoal] = useState<GoalView | null>(null);
  // only the newest read lands: an older answer coming late would put an old goal back
  const asked = useRef(0);
  const refresh = useCallback(() => {
    const ticket = ++asked.current;
    fetchGoals().then((goals) => {
      if (ticket !== asked.current) return;
      setGoal(goals.find((each) => each.machineId === machineId && each.session === session) ?? null);
    }, () => undefined);
  }, [machineId, session]);

  useEffect(() => {
    setGoal(null);
    refresh();
    let gap: ReturnType<typeof setTimeout> | undefined;
    let owed = false;
    const readForPush = (): void => {
      refresh();
      gap = setTimeout(() => {
        gap = undefined;
        if (owed) { owed = false; readForPush(); }
      }, PUSH_GAP_MS);
    };
    const stops = [
      onHostChatMessage((from, pushed) => {
        if (from !== machineId || pushed.type !== "host-chat-changed" || pushed.session !== session) return;
        if (gap === undefined) readForPush();
        else owed = true;
      }),
      onHostChatResume(refresh),
    ];
    return () => {
      asked.current++;
      clearTimeout(gap);
      for (const stop of stops) stop();
    };
  }, [machineId, session, refresh]);

  const running = goal?.status === "active";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  return { goal, refresh };
}

const CHECK = /^\[Goal, check (\d+)\] Not done yet: (.+?)\n\nKeep working toward the whole goal:\n/;

/**
 * The judge's next turn as the goal runner sends it (server/goals/runner.ts nextTurnText): its check
 * number, its reason and the rest of the message. Anything else, a look-alike typed by hand included, is null.
 */
export function goalCheckOf(text: string): { check: number; reason: string; rest: string } | null {
  const match = CHECK.exec(text);
  if (match === null) return null;
  const reason = match[2]!;
  const head = `[Goal, check ${match[1]}] Not done yet: ${reason}`;
  return { check: Number(match[1]), reason, rest: text.slice(head.length).trim() };
}

/** a spend always with its cents: $3.10, $25.00 */
export const dollars = (usd: number): string => `$${usd.toFixed(2)}`;
/** a cap with no cents when it is a whole number of dollars: $25, $25.50 */
export const capDollars = (usd: number): string => Number.isInteger(usd) ? `$${usd}` : dollars(usd);

/**
 * The goal bar's head: the spend against the cap (or how the goal ended), what it is on (the current
 * todo, else how long it has run, else how many checks it took) and its colour.
 */
export function goalHead(goal: GoalView, todos: readonly HostTodo[] | undefined, now: number): { title: string; current: string; tone: "accent" | "notice" | "done" | "ended" } {
  const spent = dollars(goal.spentUsd);
  const cap = capDollars(goal.capUsd);
  const paused = goal.status === "paused" || goal.status === "budget_limited";
  const title = goal.status === "active" ? t("Goal {spent} / {cap}", { spent, cap })
    : paused ? t("Paused · {spent} / {cap}", { spent, cap })
    : goal.status === "met" ? t("Goal met · {spent}", { spent })
    : t("Goal stopped · {spent}", { spent });
  const tone = goal.status === "met" ? "done"
    : goal.status === "stopped" ? "ended"
    : paused || goal.tone !== "ok" ? "notice"
    : "accent";
  return { title, current: currentOf(goal, todos ?? [], now), tone };
}

function currentOf(goal: GoalView, todos: readonly HostTodo[], now: number): string {
  const todo = currentTodo(todos);
  if (todo !== null) return `${todos.filter((each) => each.status === "done").length}/${todos.length} · ${todo.title}`;
  const started = Date.parse(goal.startedAt);
  if (goal.status === "active" && Number.isFinite(started)) {
    const minutes = Math.max(0, Math.floor((now - started) / 60_000));
    return minutes < 60 ? t("{n} min in", { n: minutes }) : t("{h}h {m}m in", { h: Math.floor(minutes / 60), m: minutes % 60 });
  }
  const checks = goal.judge.checks.length;
  return checks === 1 ? t("1 check") : t("{n} checks", { n: checks });
}
