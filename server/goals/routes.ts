/**
 * /api/goals (ZAC-326 part 2), on the central server: list the goals, start one on a chat, raise its
 * cap, stop it, resume a paused one. And `goalPcOver`, the GoalPc the runner and these routes read a
 * PC's chats through: this PC's own host-chats routes, or another PC's bridge with its endpoint token.
 *
 * A watching device's POST is refused before this (server/index.ts, read_only).
 */
import { createHash } from "node:crypto";
import { budgetTone, chatUsd, defaultJudge, judgeChoices, modelFamily, suggestedRaises } from "../../shared/goal-budget.ts";
import type { GoalView, HostGoal } from "../../shared/goals.ts";
import type { HostChatCost, HostChatRow } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/usage.ts";
import { badRequest, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import type { GoalPc } from "./runner.ts";
import { spent, type GoalStore } from "./store.ts";

/** The longest objective and "done when" a goal takes. */
export const GOAL_TEXT_MAX = 4_000;
const MAX_ID = 512;
const MAX_MODEL = 200;

export function goalView(goal: HostGoal): GoalView {
  const spentUsd = spent(goal);
  return { ...goal, spentUsd, tone: budgetTone(spentUsd, goal.capUsd), raises: goal.status === "budget_limited" ? suggestedRaises(spentUsd, goal.judge.checks.length) : null };
}

/**
 * The id of the turn a goal queues after the judged call `callAt`: a UUID (the bridge takes no other,
 * routes.ts idOf) made from the chat and that call, so a re-send after a restart is the same message
 * and the host's dedup by id (alreadyHas) queues it once.
 */
export function goalMessageId(machineId: string, session: string, callAt: string): string {
  const hex = createHash("sha1").update(`${machineId}\n${session}\n${callAt}`).digest("hex");
  // shaped as a name-based UUID (version 5, RFC 4122 variant)
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One request to a PC's /api/host-chats/ routes; null when it never answered. */
export type GoalPcAsk = (path: string, init?: RequestInit) => Promise<Response | null>;

async function read(ask: GoalPcAsk, path: string): Promise<{ status: number; body: unknown }> {
  const response = await ask(path).catch(() => null);
  if (!response) return { status: 0, body: null };
  if (!response.ok) { await response.body?.cancel(); return { status: response.status, body: null }; }
  try { return { status: response.status, body: await response.json() }; } catch { return { status: 0, body: null }; }
}

/** A PC's chats as the goal runner reads and drives them, over `ask`; "offline" for anything that did not answer as expected. */
export function goalPcOver(machineId: string, ask: GoalPcAsk): GoalPc {
  const query = (session: string, parent: string | null = null) => `?session=${encodeURIComponent(session)}${parent ? `&parent=${encodeURIComponent(parent)}` : ""}`;
  return {
    async row(session) {
      const { status, body } = await read(ask, "/api/host-chats/chats");
      if (status !== 200 || !isJsonObject(body) || !Array.isArray(body["chats"])) return "offline";
      return (body["chats"] as HostChatRow[]).find((row) => isJsonObject(row) && row.session === session) ?? null;
    },
    async cost(session, parent) {
      const { status, body } = await read(ask, `/api/host-chats/costs${query(session, parent)}`);
      if (status !== 200 || !isJsonObject(body)) return "offline";
      const chat = body["chat"];
      return isJsonObject(chat) && Array.isArray(chat["models"]) ? chat as unknown as HostChatCost : null;
    },
    async digest(session, parent) {
      const { status, body } = await read(ask, `/api/host-chats/goal-digest${query(session, parent)}`);
      if (status === 404) return null;
      return status === 200 && isJsonObject(body) && typeof body["digest"] === "string" ? body["digest"] : "offline";
    },
    async send(session, text, callAt) {
      const response = await ask("/api/host-chats/chat/send", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, text, mode: "queue", id: goalMessageId(machineId, session, callAt) }),
      }).catch(() => null);
      await response?.body?.cancel();
      return response?.ok === true;
    },
  };
}

type Prices = { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null };

export interface GoalRoutesDeps {
  store: GoalStore;
  /** the PC's chats; null for a PC this server does not know (404 no_machine) */
  pcs: (machineId: string) => GoalPc | null;
  prices: () => Promise<Prices>;
  /** the models a judge may run on (the owner's curated list, as the digest's), for the default judge and the judges to offer */
  models: () => Promise<string[]>;
  /** whether a picked judge is one of those models: a hand-made start cannot spend a quota the owner forbids */
  judgeAllowed: (id: string) => boolean;
  /** the owner's default judge (HERDR_WEB_GOAL_JUDGE), used when it is one of `models`; null for the family rule */
  preferredJudge: string | null;
  /** a goal was started, raised or resumed: the runner may look at it now rather than on its next tick */
  kick?: () => void;
}

const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
const refuse = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);
const id = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_ID;
const goalText = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" && value.length <= GOAL_TEXT_MAX ? value.trim() : null;
const usd = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const CHAT_BODY = "Send { machine, session }";
const noGoal = () => refuse("not_found", "This chat has no goal", 404);
const ended = () => refuse("goal_ended", "This goal is met or stopped; start a new one", 409);
const isEnded = (goal: HostGoal) => goal.status === "met" || goal.status === "stopped";

/**
 *   GET  /api/goals                                                    `{ goals: GoalView[] }`
 *   GET  /api/goals/judges?worker=<model id>                           `{ choices: JudgeChoice[] }`, the judges to offer a chat whose last model is `worker`
 *   POST /api/goals/start  { machine, session, parent?, objective, doneWhen, capUsd, judgeModel?, allowUnpriced?, away? }   `{ goal }`;
 *                          400 unpriced_model when the chat's last model has no price, unless allowUnpriced is true;
 *                          400 invalid_judge when judgeModel is not one of the owner's judges
 *   POST /api/goals/raise  { machine, session, capUsd }                `{ goal }`; 409 below_spent, goal_ended
 *   POST /api/goals/stop   { machine, session }                        `{ goal }`
 *   POST /api/goals/resume { machine, session }                        `{ goal }`, paused → active; 409 not_paused
 */
export async function handleGoalsRequest(request: Request, pathname: string, deps: GoalRoutesDeps): Promise<Response> {
  const { store } = deps;
  if (pathname === "/api/goals") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return refuse("method_not_allowed", "Use GET /api/goals", 405);
    return reply({ goals: store.list().map(goalView) });
  }
  if (pathname === "/api/goals/judges") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return refuse("method_not_allowed", "Use GET /api/goals/judges", 405);
    const worker = new URL(request.url).searchParams.get("worker") || null;
    // a list to pick from: with no prices it still offers the default judge
    const [models, priced] = await Promise.all([deps.models().catch(() => []), deps.prices().catch((): Prices => ({ prices: null, fallback: null }))]);
    return reply({ choices: judgeChoices(worker, models, priced.prices ?? {}, priced.fallback, deps.preferredJudge) });
  }
  const action = /^\/api\/goals\/(start|raise|stop|resume)$/.exec(pathname)?.[1];
  if (!action) return refuse("not_found", "not found", 404);
  setRequestRoute(pathname);
  if (request.method !== "POST") return refuse("method_not_allowed", `Use POST ${pathname}`, 405);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const machine = body["machine"];
  const session = body["session"];
  if (!id(machine) || !id(session)) return badRequest("invalid_body", CHAT_BODY);

  if (action === "start") return start(deps, machine, session, body);
  const goal = store.get(machine, session);
  if (!goal) return noGoal();
  if (action === "raise") {
    const capUsd = usd(body["capUsd"]);
    if (capUsd === null) return badRequest("invalid_body", "Send { machine, session, capUsd: dollars above 0 }");
    if (isEnded(goal)) return ended();
    try {
      const raised = store.raise(machine, session, capUsd);
      deps.kick?.();
      return reply({ goal: goalView(raised) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "below_spent") return refuse("below_spent", `The cap must be above what is spent ($${spent(goal).toFixed(2)})`, 409);
      if (code === "not_found") return noGoal();
      throw error;
    }
  }
  if (action === "stop") {
    // a goal already over stays as it ended: a met goal is not turned into a stopped one
    if (isEnded(goal)) return reply({ goal: goalView(goal) });
    const stopped = store.stop(machine, session);
    return stopped ? reply({ goal: goalView(stopped) }) : noGoal();
  }
  if (goal.status !== "paused") return refuse("not_paused", "Only a paused goal resumes", 409);
  // the next tick judges the chat as it is now: without it a goal paused on an idle chat would wait forever
  const resumed = store.update(machine, session, (each) => { each.status = "active"; each.pauseReason = null; each.lastJudgedCallAt = null; });
  if (!resumed) return noGoal();
  deps.kick?.();
  return reply({ goal: goalView(resumed) });
}

async function start(deps: GoalRoutesDeps, machine: string, session: string, body: Record<string, unknown>): Promise<Response> {
  const objective = goalText(body["objective"]);
  const doneWhen = goalText(body["doneWhen"]);
  const capUsd = usd(body["capUsd"]);
  const parent = body["parent"] === undefined || body["parent"] === null ? null : id(body["parent"]) ? body["parent"] : undefined;
  const picked = body["judgeModel"] === undefined || body["judgeModel"] === null ? null
    : typeof body["judgeModel"] === "string" && body["judgeModel"].trim() !== "" && body["judgeModel"].length <= MAX_MODEL ? body["judgeModel"].trim() : undefined;
  const away = body["away"] === undefined ? "assume" : body["away"] === "assume" || body["away"] === "wait" ? body["away"] : undefined;
  if (objective === null || doneWhen === null || capUsd === null || parent === undefined || picked === undefined || away === undefined) {
    return badRequest("invalid_body", `Send { machine, session, parent?, objective and doneWhen: 1 to ${GOAL_TEXT_MAX} characters, capUsd: dollars above 0, judgeModel?, away?: "assume" or "wait" }`);
  }
  if (picked !== null && !deps.judgeAllowed(picked)) return refuse("invalid_judge", `${picked} is not one of the judges on offer. Pick a judge from the list`, 400);
  const pc = deps.pcs(machine);
  if (!pc) return refuse("no_machine", "No such PC", 404);
  const existing = deps.store.get(machine, session);
  if (existing && !isEnded(existing)) return refuse("goal_running", "This chat already has a goal", 409);

  const row = await pc.row(session);
  if (row === "offline") return refuse("pc_offline", "This PC did not answer", 503);
  if (row === null) return refuse("no_chat", "This PC has no such chat", 404);
  const cost = await pc.cost(session, parent);
  if (cost === "offline") return refuse("pc_offline", "This PC did not answer", 503);
  let priced: Prices;
  try { priced = await deps.prices(); } catch { return refuse("prices_unavailable", "Could not read the model prices", 503); }
  // the chat's cost so far is not the goal's: the spend starts from here
  const baselineUsd = cost === null ? 0 : chatUsd(cost.models, priced.prices ?? {}, priced.fallback).usd;
  const lastModel = cost?.lastModel ?? null;
  // a model with no price (or a local one) counts $0, so the cap would never stop the goal: only on the owner's say-so
  if (lastModel !== null && body["allowUnpriced"] !== true
    && chatUsd([{ model: lastModel, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }], priced.prices ?? {}, priced.fallback).unpriced.length > 0) {
    return refuse("unpriced_model", `${lastModel} has no price, so the cap cannot count its spend; send allowUnpriced: true to start anyway`, 400);
  }
  const model = picked ?? defaultJudge(lastModel, await deps.models().catch(() => []), deps.preferredJudge);
  if (model === null) return refuse("no_judge", "No model to judge with: pick one, or connect OmniRoute", 400);
  const warning = lastModel !== null && modelFamily(model) === modelFamily(lastModel) ? "same_family" : null;
  try {
    const goal = deps.store.start({ machineId: machine, session, parent, objective, doneWhen, capUsd, away, baselineUsd: Number.isFinite(baselineUsd) ? baselineUsd : 0, judge: { model, warning } });
    deps.kick?.();
    return reply({ goal: goalView(goal) });
  } catch (error) {
    if (error instanceof Error && error.message === "goal_running") return refuse("goal_running", "This chat already has a goal", 409);
    throw error;
  }
}
