/**
 * A goal's dollar math (ZAC-326): what the chat and the judge spent at API prices, how close that is
 * to the cap, what to raise the cap to when it is reached, and which model judges by default.
 * Pure, so the central server's goal runner and the client's goal bar price a goal the same way.
 */
import { costSplit } from "./cache-cost.ts";
import type { HostCostModel } from "./host-chats.ts";
import { priceWithFallback } from "./model-price.ts";
import type { ModelPrice, ModelPrices } from "./usage.ts";

/** Share of the cap at which the goal warns. */
export const BUDGET_NOTICE = 0.8;

/**
 * A chat's cost (main agent and sub-agents, as costs.ts sums them per model) priced as the Costs sheet
 * prices it. A model with no price, or a local one, counts $0 and is named once in `unpriced`.
 */
export function chatUsd(models: readonly HostCostModel[], prices: ModelPrices, fallback: Record<string, ModelPrice> | null): { usd: number; unpriced: string[] } {
  const split = costSplit(models, prices, fallback);
  return { usd: split.usd, unpriced: [...new Set([...split.missing, ...split.local])] };
}

/**
 * One judge call's cost. `input` is OmniRoute's `prompt_tokens`, which already holds the `cached`
 * read, so only the rest is priced at the input price; the read is priced at the cache price (the
 * input price when the model has none). $0 for a model with no price or a local one.
 */
export function judgeUsd(model: string, usage: { input: number; cached: number; output: number }, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): number {
  const found = priceWithFallback(model, prices, fallback);
  if (!found || found.via === "local") return 0;
  const { price } = found;
  const cached = Math.min(usage.cached, usage.input);
  return ((usage.input - cached) * price.input + cached * (price.cached ?? price.input) + usage.output * price.output) / 1e6;
}

/** `notice` from 80 % of the cap, `over` from 100 %; `over` for a spend that is no number, so it fails closed. */
export function budgetTone(spent: number, cap: number): "ok" | "notice" | "over" {
  if (!Number.isFinite(spent) || spent >= cap) return "over";
  return spent >= cap * BUDGET_NOTICE ? "notice" : "ok";
}

const ceil5 = (usd: number): number => 5 * Math.ceil(usd / 5);

/**
 * The caps to offer when the goal reaches its cap: the spend plus 2 and 4 more judge checks at the
 * run's rate so far, rounded up to the next $5, each at least $5 above the last; the first is the
 * recommended one. Both are always above the spend.
 */
export function suggestedRaises(spent: number, checks: number): [number, number] {
  const rate = spent / Math.max(1, checks);
  const first = Math.max(ceil5(spent + 2 * rate), ceil5(spent) + 5);
  const second = Math.max(ceil5(spent + 4 * rate), first + 5);
  return [first, second];
}

/** A model's family: the id's last path segment up to its first `-` (`cc/claude-opus-5-5` → `claude`). */
export function modelFamily(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1);
  const dash = name.indexOf("-");
  return (dash < 0 ? name : name.slice(0, dash)).toLowerCase();
}

/**
 * The judge a goal gets unless the owner picks one: `preferred` (the owner's named default judge,
 * HERDR_WEB_GOAL_JUDGE) when it is one of `models`, whatever the worker's family; else the first model
 * whose family differs from the chat's last model, else the first model (the caller warns
 * `same_family`); null for an empty list.
 */
export function defaultJudge(workerModel: string | null, models: readonly string[], preferred: string | null = null): string | null {
  if (preferred !== null && models.includes(preferred)) return preferred;
  if (workerModel === null) return models[0] ?? null;
  const family = modelFamily(workerModel);
  return models.find((each) => modelFamily(each) !== family) ?? models[0] ?? null;
}

/** A judge the start sheet offers, and why: the default, the cheapest of another family, the cheapest of the worker's own. */
export interface JudgeChoice { id: string; why: "default" | "cheapest" | "same_family" }

/**
 * The judges to offer for a chat whose last model is `worker`: `defaultJudge` with the owner's
 * `preferred` judge (labelled `same_family` when its family is the worker's, as when the preferred
 * judge is of the worker's family or no other family is on offer), then the cheapest
 * priced model of another family (of any family without a worker), then the cheapest of the
 * worker's family; each model once. Cheapest is the lowest input plus output price; a local or
 * unpriced model is never offered as either.
 */
export function judgeChoices(worker: string | null, models: readonly string[], prices: ModelPrices, fallback: Record<string, ModelPrice> | null, preferred: string | null = null): JudgeChoice[] {
  const family = worker === null ? null : modelFamily(worker);
  const cost = (id: string): number | null => {
    const found = priceWithFallback(id, prices, fallback);
    return !found || found.via === "local" ? null : found.price.input + found.price.output;
  };
  const cheapest = (sameFamily: boolean): string | null => {
    let best: { id: string; usd: number } | null = null;
    for (const id of models) {
      if ((modelFamily(id) === family) !== sameFamily) continue;
      const usd = cost(id);
      if (usd !== null && (best === null || usd < best.usd)) best = { id, usd };
    }
    return best?.id ?? null;
  };
  const byDefault = defaultJudge(worker, models, preferred);
  const picks: [string | null, JudgeChoice["why"]][] = [
    // the default is the worker's own family (preferred so, or no other on offer), so it says so
    [byDefault, byDefault !== null && modelFamily(byDefault) === family ? "same_family" : "default"],
    [cheapest(false), "cheapest"],
    [family === null ? null : cheapest(true), "same_family"],
  ];
  const choices: JudgeChoice[] = [];
  for (const [id, why] of picks) if (id !== null && !choices.some((each) => each.id === id)) choices.push({ id, why });
  return choices;
}
