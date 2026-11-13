import type { GoalView } from "../../shared/goals.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { capDollars, dollars, raiseGoal, resumeGoal, stopGoal } from "../lib/hostGoals.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { PromptCardView, type PromptChoice } from "./PromptCard.tsx";

/** a paused goal's reason in words: the runner's codes (server/goals/runner.ts), else the judge's own */
function reasonWords(reason: string, t: Translate): string {
  if (reason.startsWith("judge_error: ")) return t("The judge failed: {reason}.", { reason: reason.slice("judge_error: ".length) });
  switch (reason) {
    case "no_chat": return t("The chat is gone from its PC.");
    case "no_cost": return t("Its cost can't be read.");
    case "no_log": return t("Its log can't be read.");
    case "send_failed": return t("The next turn couldn't be sent.");
    case "cap": return t("It reached its cap.");
    default: return reason;
  }
}

/** What a paused goal asks: at its cap, the two raises and a stop; paused for a reason, resume or stop. */
export function goalPausePrompt(goal: GoalView, t: Translate): InteractivePrompt {
  const raising = goal.status === "budget_limited";
  const title = raising ? t("Goal paused at its {cap} budget", { cap: capDollars(goal.capUsd) }) : t("Goal paused");
  const checks = goal.judge.checks.length;
  const body = raising
    ? t("Spent {spent}: chat {chat}, judge {judge}, over {checks}.", {
      spent: dollars(goal.spentUsd), chat: dollars(goal.chatUsd), judge: dollars(goal.judgeUsd),
      checks: checks === 1 ? t("1 check") : t("{n} checks", { n: checks }),
    })
    : goal.pauseReason === null ? null : reasonWords(goal.pauseReason, t);
  const go = raising
    ? (goal.raises ?? []).map((cap, index) => ({ label: t("Raise to {cap} and continue", { cap: capDollars(cap) }), description: null, ...(index === 0 ? { recommended: true as const } : {}) }))
    : [{ label: t("Resume"), description: null }];
  return {
    // a raise changes the cap, so the card after it is a new one
    id: `goal:${goal.session}:${goal.status}:${goal.capUsd}`,
    agent: "copilot", kind: "menu", title, question: title, body,
    options: [...go, { label: t("Stop here"), description: null }],
    multi_select: false, custom_option_index: null,
  };
}

/**
 * A paused goal's card in the chat's prompt dock (ZAC-326), in the prompt card's markup: a pick
 * raises the cap, resumes or stops the goal. A refusal (a watching device, a cap below the spend)
 * is the card's error, and the card stays.
 */
export function GoalPauseCard({ machineId, session, goal, onDone }: { machineId: string; session: string; goal: GoalView; onDone(): void }) {
  const t = useT();
  const prompt = goalPausePrompt(goal, t);
  // each option's meaning, in the prompt's order: the raises or resume, then the stop
  const actions: (() => Promise<GoalView>)[] = [
    ...(goal.status === "budget_limited"
      ? (goal.raises ?? []).map((cap) => () => raiseGoal(machineId, session, cap))
      : [() => resumeGoal(machineId, session)]),
    () => stopGoal(machineId, session),
  ];
  const submit = async (choice: PromptChoice): Promise<void> => {
    // a pick the card did not offer spends nothing
    const action = typeof choice.option_index === "number" && choice.option_index >= 0 ? actions[choice.option_index] : undefined;
    if (action === undefined) throw new Error(t("That choice isn't on this card."));
    await action();
  };
  return <PromptCardView key={prompt.id} prompt={prompt} submit={submit} onPromptChanged={onDone} onAnswered={onDone} markdown />;
}
