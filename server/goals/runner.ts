/**
 * The goal runner (ZAC-326 part 2), on the central server. A reconciler: each tick it reads every
 * active goal's chat on its PC and acts at most once per finished turn, keyed on the chat's last
 * model call (`lastCallAt`). The check and the call it judged are saved in one store update, so a
 * restart of the central server loses no turn and judges none twice.
 *
 * Per turn: price the chat, stop at the cap before the judge runs, judge, then mark the goal met,
 * pause it (impossible, judge error, failed send) or queue the next turn on the chat.
 */
import { chatUsd, judgeUsd } from "../../shared/goal-budget.ts";
import type { HostChatCost, HostChatRow } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/usage.ts";
import { judge } from "./judge.ts";
import { spent, type GoalCheck, type GoalStore, type HostGoal } from "./store.ts";

/** One PC's chats, as the runner reads and drives them; "offline" when the PC did not answer. */
export interface GoalPc {
  row(session: string): Promise<HostChatRow | null | "offline">;
  cost(session: string, parent: string | null): Promise<HostChatCost | null | "offline">;
  digest(session: string, parent: string | null): Promise<string | null | "offline">;
  /** POST host-chats/chat/send, mode "queue"; false when it was not delivered */
  send(session: string, text: string): Promise<boolean>;
}

type Prices = { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null };

export interface GoalRunnerDeps {
  store: GoalStore;
  pcs: (machineId: string) => GoalPc | null;
  prices: () => Promise<Prices>;
  complete: Parameters<typeof judge>[0];
  now?: () => number;
  log?: (line: string) => void;
}

/** The next turn's message (Global Constraints), rules verbatim. */
export function nextTurnText(input: { check: number; reason: string; doneWhen: string; spentUsd: number; capUsd: number }): string {
  return `[Goal, check ${input.check}] Not done yet: ${input.reason}

Keep working toward the whole goal:
- keep the whole objective; never shrink it to what fits in one turn;
- work from the repo as it is now, not from memory;
- don't swap in a smaller, safer or easier-to-test solution;
- before saying done, list each part of "done when" with the evidence that proves it;
- call it blocked only after the same blocker shows up 3 turns running.

Done when: ${input.doneWhen}
Spent $${input.spentUsd.toFixed(2)} of $${input.capUsd.toFixed(2)}.`;
}

/** `call` is no newer than `judged` (ISO times; compared as text when one does not parse) */
function notNewer(call: string, judged: string | null): boolean {
  if (judged === null) return false;
  const a = Date.parse(call);
  const b = Date.parse(judged);
  return Number.isFinite(a) && Number.isFinite(b) ? a <= b : call <= judged;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createGoalRunner(deps: GoalRunnerDeps): { step(goal: HostGoal): Promise<void>; tick(): Promise<void> } {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const { store } = deps;
  let ticking = false;

  async function stepWith(input: HostGoal, priced: Prices): Promise<void> {
    const goal = store.get(input.machineId, input.session);
    if (!goal || goal.status !== "active") return;
    const pc = deps.pcs(goal.machineId);
    if (!pc) return;
    const { machineId, session } = goal;

    // 1. a finished turn not judged yet ("error" ended the turn too)
    const row = await pc.row(session);
    if (row === null || row === "offline") return;
    if (row.archived || row.status === "working" || row.status === "asks") return;
    const cost = await pc.cost(session, goal.parent);
    if (cost === null || cost === "offline") return;
    const callAt = cost.lastCallAt;
    if (!callAt || notNewer(callAt, goal.lastJudgedCallAt)) return;

    // 2. the spend, and the cap before the judge runs; a spend that is no number fails closed
    const prices = priced.prices ?? {};
    const chat = chatUsd(cost.models, prices, priced.fallback);
    const chatSpent = Math.max(0, chat.usd - goal.baselineUsd);
    const total = spent({ chatUsd: chatSpent, judgeUsd: goal.judgeUsd });
    const capped = store.update(machineId, session, (each) => {
      each.unpriced = chat.unpriced;
      if (Number.isFinite(total)) each.chatUsd = chatSpent;
      if (each.status === "active" && !(total < each.capUsd)) { each.status = "budget_limited"; each.pauseReason = "cap"; }
    });
    if (!capped || capped.status !== "active") return;

    // 3. judge the turn; the check and the call it judged are saved in one update
    const digest = await pc.digest(session, goal.parent);
    if (digest === null || digest === "offline") return;
    const answer = await judge(deps.complete, { model: goal.judge.model, doneWhen: goal.doneWhen, digest });
    const usd = answer.usage ? judgeUsd(goal.judge.model, answer.usage, prices, priced.fallback) : 0;
    const at = new Date(now()).toISOString();
    const check: GoalCheck = "error" in answer
      ? { at, callAt, verdict: "error", reason: answer.error, usd }
      : { at, callAt, verdict: answer.verdict, reason: answer.reason, usd };
    const judged = store.update(machineId, session, (each) => {
      if (Number.isFinite(usd)) each.judgeUsd += usd;
      each.judge.checks.push(check);
      each.lastJudgedCallAt = callAt;
      // stopped or paused by the owner while the judge ran: the check is kept, the goal left as it is
      if (each.status !== "active") return;
      // 4. what the answer does to the goal
      if (!Number.isFinite(usd)) { each.status = "budget_limited"; each.pauseReason = "cap"; return; }
      if ("error" in answer) { each.status = "paused"; each.pauseReason = `judge_error: ${answer.error}`; return; }
      if (answer.verdict === "met") { each.status = "met"; each.pauseReason = null; return; }
      if (answer.verdict === "impossible") { each.status = "paused"; each.pauseReason = answer.reason; }
    });
    if (!judged || judged.status !== "active" || "error" in answer || answer.verdict !== "not_met") return;

    const text = nextTurnText({ check: judged.judge.checks.length, reason: answer.reason, doneWhen: judged.doneWhen, spentUsd: spent(judged), capUsd: judged.capUsd });
    const sent = await pc.send(session, text).catch(() => false);
    if (!sent) {
      store.update(machineId, session, (each) => {
        if (each.status === "active") { each.status = "paused"; each.pauseReason = "send_failed"; }
      });
    }
  }

  return {
    async step(goal) {
      await stepWith(goal, await deps.prices());
    },
    /** Every active goal, one at a time; a tick that starts while one still runs does nothing. */
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        let priced: Prices;
        try { priced = await deps.prices(); } catch (error) {
          log(`goals: no prices, nothing run this tick: ${messageOf(error)}`);
          return;
        }
        for (const goal of store.list()) {
          if (goal.status !== "active") continue;
          try { await stepWith(goal, priced); } catch (error) {
            log(`goals: the step of ${goal.machineId}/${goal.session} failed: ${messageOf(error)}`);
          }
        }
      } finally {
        ticking = false;
      }
    },
  };
}
