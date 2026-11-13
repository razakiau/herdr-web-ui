/**
 * The goal of each chat (ZAC-326 part 2): one per `(machineId, session)`, kept on the central
 * server in `$STATE/goals.json` (0600) and rewritten on every change, so a restart picks up every
 * goal where it was. The runner and the API read and change goals only through this store.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import type { Verdict } from "./judge.ts";

export type GoalStatus = "active" | "paused" | "budget_limited" | "met" | "stopped";

export interface GoalCheck {
  at: string;
  /** the chat's lastCallAt this check judged */
  callAt: string;
  verdict: Verdict | "error";
  reason: string;
  usd: number;
  /** a not_met check's next turn reached the chat; false until the send succeeds, so a restart in between re-sends it */
  sent: boolean;
}

export interface HostGoal {
  machineId: string;
  session: string;
  parent: string | null;
  objective: string;
  doneWhen: string;
  status: GoalStatus;
  pauseReason: string | null;
  capUsd: number;
  /** the chat's priced cost when the goal started */
  baselineUsd: number;
  /** the chat's priced cost since the start (main agent and sub-agents) */
  chatUsd: number;
  /** every judge call's cost */
  judgeUsd: number;
  /** models of the chat with no price, counted $0 */
  unpriced: string[];
  judge: { model: string; warning: "same_family" | null; checks: GoalCheck[] };
  lastJudgedCallAt: string | null;
  startedAt: string;
  updatedAt: string;
}

export type GoalStart = Omit<HostGoal, "status" | "pauseReason" | "chatUsd" | "judgeUsd" | "unpriced" | "lastJudgedCallAt" | "startedAt" | "updatedAt" | "judge">
  & { judge: { model: string; warning: "same_family" | null } };

/** How many judge checks a goal keeps, newest last */
export const GOAL_CHECKS = 50;

/** What a goal has cost so far: the chat since the start plus the judge */
export function spent(goal: Pick<HostGoal, "chatUsd" | "judgeUsd">): number {
  return goal.chatUsd + goal.judgeUsd;
}

/** A goal that still runs: a second one on its chat is refused until it is met or stopped */
const running = (goal: HostGoal): boolean => goal.status === "active" || goal.status === "paused" || goal.status === "budget_limited";

const isGoal = (each: unknown): each is HostGoal => {
  if (!each || typeof each !== "object") return false;
  const goal = each as Partial<HostGoal>;
  return typeof goal.machineId === "string" && typeof goal.session === "string" && typeof goal.status === "string"
    && typeof goal.capUsd === "number" && !!goal.judge && Array.isArray(goal.judge.checks);
};

const copy = (goal: HostGoal): HostGoal => structuredClone(goal);

/** A check saved before `sent` existed counts as sent, so nothing old is sent again */
const withSent = (goal: HostGoal): HostGoal => ({
  ...goal,
  judge: { ...goal.judge, checks: goal.judge.checks.map((check) => typeof check.sent === "boolean" ? check : { ...check, sent: true }) },
});

export class GoalStore {
  private readonly path: string;
  private readonly now: () => number;
  private goals: HostGoal[];
  constructor(stateDir: string, now: () => number = Date.now) {
    this.path = join(stateDir, "goals.json");
    this.now = now;
    this.goals = [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (Array.isArray(raw)) this.goals = raw.filter(isGoal).map(withSent);
    } catch { /* none yet, or unreadable: the next goal starts the file again */ }
  }

  list(): HostGoal[] { return this.goals.map(copy); }

  get(machineId: string, session: string): HostGoal | null {
    const goal = this.find(machineId, session);
    return goal ? copy(goal) : null;
  }

  /** Throws "goal_running" when the chat's goal is active, paused or budget_limited; a met or stopped one is replaced. */
  start(input: GoalStart): HostGoal {
    const existing = this.find(input.machineId, input.session);
    if (existing && running(existing)) throw new Error("goal_running");
    const at = new Date(this.now()).toISOString();
    const goal: HostGoal = {
      machineId: input.machineId,
      session: input.session,
      parent: input.parent,
      objective: input.objective,
      doneWhen: input.doneWhen,
      status: "active",
      pauseReason: null,
      capUsd: input.capUsd,
      baselineUsd: input.baselineUsd,
      chatUsd: 0,
      judgeUsd: 0,
      unpriced: [],
      judge: { model: input.judge.model, warning: input.judge.warning, checks: [] },
      lastJudgedCallAt: null,
      startedAt: at,
      updatedAt: at,
    };
    this.goals = [...this.goals.filter((each) => each !== existing), goal];
    this.save();
    return copy(goal);
  }

  /** Applies `change` to a copy, keeps the newest checks, stamps updatedAt and saves; null for an unknown goal. */
  update(machineId: string, session: string, change: (goal: HostGoal) => void): HostGoal | null {
    const existing = this.find(machineId, session);
    if (!existing) return null;
    const goal = copy(existing);
    change(goal);
    // the chat a goal belongs to never changes under it
    goal.machineId = existing.machineId;
    goal.session = existing.session;
    goal.judge.checks = goal.judge.checks.slice(-GOAL_CHECKS);
    goal.updatedAt = new Date(this.now()).toISOString();
    this.goals = this.goals.map((each) => each === existing ? goal : each);
    this.save();
    return copy(goal);
  }

  /**
   * A new cap, above what is spent (else "below_spent", nothing changed; "not_found" for no goal).
   * A budget_limited goal continues; a paused one stays paused, its reason kept. The spend never resets.
   */
  raise(machineId: string, session: string, capUsd: number): HostGoal {
    const existing = this.find(machineId, session);
    if (!existing) throw new Error("not_found");
    if (!(capUsd > spent(existing))) throw new Error("below_spent");
    return this.update(machineId, session, (goal) => {
      goal.capUsd = capUsd;
      if (goal.status === "budget_limited") { goal.status = "active"; goal.pauseReason = null; }
    })!;
  }

  /** null for an unknown goal */
  stop(machineId: string, session: string): HostGoal | null {
    return this.update(machineId, session, (goal) => { goal.status = "stopped"; goal.pauseReason = null; });
  }

  private find(machineId: string, session: string): HostGoal | undefined {
    return this.goals.find((each) => each.machineId === machineId && each.session === session);
  }

  private save(): void { writePrivateState(this.path, this.goals); }
}
