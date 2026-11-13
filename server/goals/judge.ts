/**
 * A chat goal's judge (ZAC-326): after each turn a second model reads what the agent did and says
 * whether the goal's "done when" is proven. Ported from zhomelab's `cop-goal` (ZAC-102), whose
 * digest, prompt and verdict parsing are kept as they are: the same transcript gets the same
 * verdict whether `cop --goal` or Ovis asks.
 *
 * The judge never throws: a failed call or an answer that is not a verdict comes back as `error`,
 * and the runner pauses the goal on it. A broken judge must never keep an agent looping.
 */
import type { Verdict } from "../../shared/goals.ts";
import type { OmniRouteCompletion } from "../omniroute.ts";

export type { Verdict } from "../../shared/goals.ts";

/** The newest bytes of the digest the judge reads: ~15k tokens, the evidence of the last few turns. */
export const DIGEST_BYTES = 60_000;
const FIELD_BYTES = 4000;
const VERDICTS: readonly string[] = ["met", "not_met", "impossible"];

function clip(value: unknown, n = FIELD_BYTES): string {
  const s = String(value ?? "");
  return s.length <= n ? s : `${s.slice(0, n / 2)}\n[… ${s.length - n} chars cut …]\n${s.slice(-n / 2)}`;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" ? value as Row : {};

/**
 * A Copilot events.jsonl reduced to what the agent did and saw: user messages, its replies, tool
 * calls and their results, one line each (cop-goal's `digest`). The system prompt and bookkeeping
 * are left out; past `maxBytes` only the newest part is kept.
 */
export function digestOf(jsonl: string, maxBytes = DIGEST_BYTES): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Row;
    try { event = record(JSON.parse(line)); } catch { continue; }
    const data = record(event["data"] || {});
    switch (event["type"]) {
      case "user.message":
        out.push(`USER: ${clip(data["content"])}`);
        break;
      case "assistant.message":
        if (String(data["content"] || "").trim()) out.push(`AGENT: ${clip(data["content"])}`);
        break;
      case "tool.execution_start": {
        const args = record(data["arguments"] || {});
        const shown = args["command"] ?? args["path"] ?? args["pattern"] ?? args["url"] ?? JSON.stringify(data["arguments"] || {});
        out.push(`TOOL ${data["toolName"]}: ${clip(shown, 1000)}`);
        break;
      }
      case "tool.execution_complete": {
        const result = data["result"];
        const shown = result && typeof result === "object" ? record(result)["content"] ?? JSON.stringify(result) : result;
        out.push(`RESULT${data["success"] === false ? " (failed)" : ""}: ${clip(shown)}`);
        break;
      }
    }
  }
  const text = out.join("\n");
  return text.length <= maxBytes ? text : `[… earlier turns cut …]\n${text.slice(-maxBytes)}`;
}

/** cop-goal's `SYSTEM`, word for word. */
export const JUDGE_SYSTEM = `You check whether a coding agent has achieved a goal. You read the agent's transcript and decide from its evidence only.

Rules:
- "met" only if the transcript PROVES every part of the condition: command output, test results, file contents the agent printed. The agent saying it is done, or intending to do something, is not proof.
- "not_met" if any part is unproven or missing. Your reason is sent to the agent as its next instruction: say concretely what is still missing and what evidence would prove it. Be brief.
- "impossible" only if the transcript shows the condition cannot be satisfied at all (it contradicts itself, or needs something that does not exist and cannot be created). Not merely hard or slow.
- Constraints in the condition count: if the agent broke one, it is "not_met".

Answer with one JSON object and nothing else: {"verdict": "met" | "not_met" | "impossible", "reason": "<one or two sentences>"}`;

/** The verdict in a model's answer (the first `{` to the last `}`); throws when there is none. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in evaluator answer");
  const answer = record(JSON.parse(match[0]));
  if (typeof answer["verdict"] !== "string" || !VERDICTS.includes(answer["verdict"])) throw new Error(`bad verdict ${JSON.stringify(answer["verdict"])}`);
  return { verdict: answer["verdict"] as Verdict, reason: String(answer["reason"] || "").slice(0, 1500) };
}

export type JudgeComplete = (request: { model: string; effort: string; system: string; user: string }) => Promise<OmniRouteCompletion>;
export type JudgeAnswer =
  | { verdict: Verdict; reason: string; usage: OmniRouteCompletion["usage"] }
  | { error: string; usage: OmniRouteCompletion["usage"] | null };

/**
 * One check: `model` reads `digest` against `doneWhen` at low effort. A failed call answers its
 * error with no usage; an answer that is no verdict keeps the call's usage, which is still paid.
 */
export async function judge(complete: JudgeComplete, input: { model: string; doneWhen: string; digest: string }): Promise<JudgeAnswer> {
  let completion: OmniRouteCompletion;
  try {
    completion = await complete({ model: input.model, effort: "low", system: JUDGE_SYSTEM, user: `CONDITION:\n${input.doneWhen}\n\nTRANSCRIPT (oldest first):\n${input.digest}` });
  } catch (error) {
    return { error: messageOf(error), usage: null };
  }
  try {
    return { ...parseVerdict(completion.text), usage: completion.usage };
  } catch (error) {
    return { error: messageOf(error), usage: completion.usage };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
