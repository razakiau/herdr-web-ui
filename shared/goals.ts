/**
 * A chat's goal (ZAC-326) as the central server keeps it (server/goals/store.ts) and GET /api/goals
 * lists it (server/goals/routes.ts): shared so the client reads the same shape the server writes.
 */

/** What the judge said of a turn. */
export type Verdict = "met" | "not_met" | "impossible";

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
  /** an optional question while the owner is away: "assume" takes its recommendation after 60 s, "wait" leaves it for the owner */
  away: "assume" | "wait";
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

/** A goal as GET /api/goals lists it: what it has spent, how close that is to the cap, and the caps to offer once it is reached. */
export type GoalView = HostGoal & { spentUsd: number; tone: "ok" | "notice" | "over"; raises: [number, number] | null };
