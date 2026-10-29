/**
 * The Session sheet's per-message chart (ZAC-260): one bar per message the user sent, its calls'
 * cost stacked, the part spent rewriting the cache in red (`--status-blocked`) over the rest, and
 * the context each message sent as a dashed line (`--accent`) on its own scale. Inline SVG.
 */
import type { HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice } from "../../shared/protocol.ts";
import { writePrice } from "../lib/sessionCost.ts";

/** One message's calls: the main agent's and its sub-agents' together; `context` the main agent's prompt. */
export interface MessageCost { at: string; rewrite: number; rest: number; context: number }

/** relative weights when the model has no price: the shape still reads, the scale is not dollars */
const UNPRICED: ModelPrice = { input: 1, cached: 0.1, output: 5 };

/**
 * The calls by message: the bridge lists each message's main-agent calls, then its sub-agents',
 * so a sub-agent entry right after a main one is the same message. Priced at `price` (the chat's
 * model), cache writes at `writePrice`.
 */
export function messageCosts(calls: readonly HostCostCall[], model: string, price: ModelPrice | null): MessageCost[] {
  const each = price ?? UNPRICED;
  const write = price ? writePrice(model, price.input) : 2;
  const groups: MessageCost[] = [];
  let previousMain = false;
  for (const call of calls) {
    const joins = !call.main && previousMain && groups.length > 0;
    previousMain = call.main;
    const fresh = Math.max(0, call.input - call.cacheRead - call.cacheWrite);
    const rewrite = call.cacheWrite * write / 1e6;
    const rest = (fresh * each.input + call.cacheRead * (each.cached ?? each.input) + call.output * each.output) / 1e6;
    if (joins) {
      const last = groups[groups.length - 1]!;
      last.rewrite += rewrite;
      last.rest += rest;
      continue;
    }
    // the message's last main call's own prompt: `input` sums its whole tool loop
    groups.push({ at: call.at, rewrite, rest, context: call.main ? call.context : 0 });
  }
  return groups;
}

const WIDTH = 300;
const HEIGHT = 110;

export function CostChart({ messages, label }: { messages: readonly MessageCost[]; label: string }) {
  if (messages.length === 0) return null;
  const top = Math.max(...messages.map((each) => each.rewrite + each.rest)) || 1;
  const peak = Math.max(...messages.map((each) => each.context)) || 1;
  const slot = WIDTH / messages.length;
  const bar = Math.max(1, Math.min(8, slot * 0.6));
  const x = (index: number): number => index * slot + (slot - bar) / 2;
  const line = messages.map((each, index) => `${index === 0 ? "M" : "L"}${(x(index) + bar / 2).toFixed(1)},${(HEIGHT - (each.context / peak) * (HEIGHT - 4)).toFixed(1)}`).join(" ");
  return <svg className="session-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {messages.map((each, index) => {
      const rest = (each.rest / top) * HEIGHT;
      const rewrite = (each.rewrite / top) * HEIGHT;
      return <g key={index}>
        <rect x={x(index)} y={HEIGHT - rest} width={bar} height={rest} fill="var(--status-working)" />
        {rewrite > 0 && <rect x={x(index)} y={HEIGHT - rest - rewrite} width={bar} height={rewrite} fill="var(--status-blocked)" />}
      </g>;
    })}
    <path d={line} fill="none" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
  </svg>;
}
