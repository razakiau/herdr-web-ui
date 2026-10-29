/**
 * The Session sheet's per-reply chart (ZAC-260, owner's pick C): one bar per reply of the owner
 * (a message he sent or his answer to `ask_user` / `askUser`), its calls' cost stacked, the part
 * cold restarts stored again in red (`--status-blocked`) on top of the rest, the context each reply
 * ended at as a solid line (`--accent`) on its own scale, and the average cost per reply as a dotted
 * line. A legend above it, a time axis under it, no paragraph. Inline SVG.
 */
import type { HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice } from "../../shared/protocol.ts";
import { formatUsd } from "../lib/chatCost.ts";
import { useT } from "../lib/i18n.ts";
import { writePrice } from "../lib/sessionCost.ts";

/** One reply's calls: the main agent's and its sub-agents' together; `context` the main agent's prompt. */
export interface MessageCost { at: string; restart: number; rest: number; context: number }

/** relative weights when the model has no price: the shape still reads, the scale is not dollars */
const UNPRICED: ModelPrice = { input: 1, cached: 0.1, output: 5 };

/**
 * The calls by reply: the bridge lists each reply's main-agent calls, then its sub-agents', so a
 * sub-agent entry right after a main one is the same reply. Priced at `price` (the chat's model):
 * the prompt less its cache read at input (Copilot's `inputTokens` holds the read, not the write),
 * the read at the cache price, the writes at `writePrice`, a cold restart's (`coldWrite`) apart.
 */
export function messageCosts(calls: readonly HostCostCall[], model: string, price: ModelPrice | null): MessageCost[] {
  const each = price ?? UNPRICED;
  const write = price ? writePrice(model, price.input) : 2;
  const groups: MessageCost[] = [];
  let previousMain = false;
  for (const call of calls) {
    const joins = !call.main && previousMain && groups.length > 0;
    previousMain = call.main;
    const fresh = Math.max(0, call.input - call.cacheRead);
    const cold = Math.min(call.coldWrite ?? 0, call.cacheWrite);
    const restart = cold * write / 1e6;
    const rest = (fresh * each.input + call.cacheRead * (each.cached ?? each.input) + (call.cacheWrite - cold) * write + call.output * each.output) / 1e6;
    if (joins) {
      const last = groups[groups.length - 1]!;
      last.restart += restart;
      last.rest += rest;
      continue;
    }
    // the reply's last main call's own prompt: `input` sums its whole tool loop
    groups.push({ at: call.at, restart, rest, context: call.main ? call.context : 0 });
  }
  return groups;
}

/**
 * The time axis under the bars, which are spaced by reply, not by time: the first reply's time, the
 * replies a third and two thirds along, then `now`; a chart of one or two replies has no middle.
 */
export function chartTicks(times: readonly string[], clock: (iso: string) => string, now: string): string[] {
  if (times.length === 0) return [];
  const last = times.length - 1;
  const middle = last >= 3 ? [Math.round(last / 3), Math.round((2 * last) / 3)].map((index) => clock(times[index]!)) : [];
  return [clock(times[0]!), ...middle, now];
}

const WIDTH = 300;
const HEIGHT = 120;
/** the tallest bar's share of the plot: room above it, so it never touches the legend */
const HEADROOM = 0.86;

export function CostChart({ messages, priced }: { messages: readonly MessageCost[]; priced: boolean }) {
  const t = useT();
  if (messages.length === 0) return null;
  const totals = messages.map((each) => each.restart + each.rest);
  const top = (Math.max(...totals) || 1) / HEADROOM;
  const peak = Math.max(...messages.map((each) => each.context)) || 1;
  const average = totals.reduce((sum, each) => sum + each, 0) / messages.length;
  const slot = WIDTH / messages.length;
  const bar = Math.max(1, Math.min(8.5, slot * 0.62));
  const x = (index: number): number => index * slot + (slot - bar) / 2;
  const y = (value: number): number => HEIGHT - (value / top) * HEIGHT;
  const line = messages.map((each, index) => `${index === 0 ? "M" : "L"}${(x(index) + bar / 2).toFixed(1)},${(HEIGHT - (each.context / peak) * HEIGHT * HEADROOM).toFixed(1)}`).join(" ");
  const clock = (iso: string): string => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  const ticks = chartTicks(messages.map((each) => each.at), clock, t("now"));
  const averageY = y(average);
  return <div className="session-chart">
    <div className="session-chart-head">
      <span className="session-kicker">{t("Per reply")}</span>
      {priced && <span className="session-chart-avg">{t("avg")} <strong>{formatUsd(average)}</strong></span>}
    </div>
    <div className="session-chart-legend" aria-hidden="true">
      <span><i className="is-cost" />{t("Cost")}</span>
      <span><i className="is-restart" />{t("Cold restart")}</span>
      <span><i className="is-context" />{t("Context")}</span>
    </div>
    <div className="session-chart-plot">
      <svg className="session-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={t("Cost per reply")}>
        <line x1={0} x2={WIDTH} y1={averageY} y2={averageY} stroke="var(--text-dim)" strokeOpacity="0.5" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        {messages.map((each, index) => {
          const rest = (each.rest / top) * HEIGHT;
          const restart = (each.restart / top) * HEIGHT;
          return <g key={index}>
            <rect x={x(index)} y={HEIGHT - rest} width={bar} height={rest} rx={1.5} fill="var(--status-working)" />
            {restart > 0 && <rect x={x(index)} y={HEIGHT - rest - restart} width={bar} height={restart} rx={1.5} fill="var(--status-blocked)" />}
          </g>;
        })}
        <path d={line} fill="none" stroke="var(--accent)" strokeOpacity="0.7" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="session-chart-tag" style={{ top: `${(averageY / HEIGHT) * 100}%` }} aria-hidden="true">{t("avg")}</span>
    </div>
    <div className="session-chart-axis" aria-hidden="true">{ticks.map((tick, index) => <span key={index}>{tick}</span>)}</div>
  </div>;
}
