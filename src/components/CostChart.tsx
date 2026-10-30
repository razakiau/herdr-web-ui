/**
 * The Session sheet's per-reply chart (ZAC-260, owner's picks C then B). Each bar is one reply of
 * the owner (a message he sent, or his answer to `ask_user` / `askUser`). Up to 40 replies there is
 * one bar each. Past 40 the chart opens on one bar per calendar day in the device's time zone; a
 * "Replies | Days" switch, remembered per device, keeps the replies instead, scrolled sideways at a
 * fixed slot and opened at the end.
 *
 * A bar is its calls' cost stacked, the part cold restarts stored again in red (`--status-blocked`).
 * The context each bar ended at (a day's largest) is a solid line (`--accent`). The average bar is
 * a dotted line. The axes: $ on the left for the bars, K on the right for the line in the accent
 * colour, light gridlines between them.
 *
 * Tap or click a bar, or use the arrow keys and Enter, to see its card above the plot: what it
 * cost, its cold restarts, its context. Escape, or a tap outside, clears it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice } from "../../shared/protocol.ts";
import { formatUsd } from "../lib/chatCost.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { writePrice } from "../lib/sessionCost.ts";

/**
 * One reply's calls, the main agent's and its sub-agents' together; `context` is the main agent's
 * prompt. `calls` and `restarts` count the calls and cold restarts; they are null from a bridge
 * before bundle 1071, which does not count them.
 */
export interface MessageCost { at: string; restart: number; rest: number; context: number; calls: number | null; restarts: number }

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
    const counted = call.calls ?? null;
    const restarts = call.restarts ?? (cold > 0 ? 1 : 0);
    if (joins) {
      const last = groups[groups.length - 1]!;
      last.restart += restart;
      last.rest += rest;
      last.calls = last.calls === null || counted === null ? null : last.calls + counted;
      last.restarts += restarts;
      continue;
    }
    // the reply's last main call's own prompt: `input` sums its whole tool loop
    groups.push({ at: call.at, restart, rest, context: call.main ? call.context : 0, calls: counted, restarts });
  }
  return groups;
}

/** One bar: a reply, or a day of them. `replies` is 1 for a reply; `index` is its place from 0. */
export interface ChartBar extends MessageCost { index: number; replies: number }

/** Past this many replies the chart opens on days (owner, option B). */
export const DAYS_OVER = 40;
export type ChartMode = "replies" | "days";
const MODE_KEY = "ovis:cost-chart-mode";

/** The mode a chart of `count` replies opens in: replies up to 40, else the stored choice, else days. */
export function chartMode(count: number, stored: string | null): ChartMode {
  if (count <= DAYS_OVER) return "replies";
  return stored === "replies" || stored === "days" ? stored : "days";
}

/** "YYYY-MM-DD" of `iso` in `timeZone` (the device's when undefined). */
export function dayKey(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * One bar per calendar day in `timeZone`: the cost and the cold restarts summed, the context the
 * day's largest, `at` the day's first reply. The calls are null if any reply has no count.
 */
export function dayCosts(messages: readonly MessageCost[], timeZone?: string): ChartBar[] {
  const days: ChartBar[] = [];
  let last = "";
  for (const message of messages) {
    const key = dayKey(message.at, timeZone);
    const day = days[days.length - 1];
    if (day && key === last) {
      day.restart += message.restart;
      day.rest += message.rest;
      day.context = Math.max(day.context, message.context);
      day.calls = day.calls === null || message.calls === null ? null : day.calls + message.calls;
      day.restarts += message.restarts;
      day.replies += 1;
      continue;
    }
    last = key;
    days.push({ ...message, index: days.length, replies: 1 });
  }
  return days;
}

/**
 * Tick values from 0 for an axis up to `max`: a step of 1, 2, 2.5 or 5 × 10ⁿ, the fewest that keeps
 * the axis at 3 intervals or less. That always gives 3 or 4 ticks, the last at or above `max`.
 */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const clean = (value: number): number => Number(value.toPrecision(12));
  let power = 10 ** (Math.floor(Math.log10(max / 3)) - 1);
  for (;;) {
    for (const mantissa of [1, 2, 2.5, 5]) {
      const step = clean(mantissa * power);
      const intervals = Math.ceil(clean(max / step));
      if (intervals <= 3) return Array.from({ length: intervals + 1 }, (_, index) => clean(index * step));
    }
    power *= 10;
  }
}

/** "$0", "$0.25", "$2.5", "$20", "$1.5K": a tick of the $ axis */
export function tickUsd(usd: number): string {
  if (usd >= 1000) return `$${Number((usd / 1000).toFixed(1))}K`;
  return `$${Number(usd.toFixed(2))}`;
}

/** "0K", "150K", "1.5M": a tick of the context axis */
export function tickTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000 || tokens === 0) return `${Number((tokens / 1_000).toFixed(1))}K`;
  return String(tokens);
}

/** "214K" in the card: the context in thousands */
const cardTokens = (tokens: number): string => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}K`;

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

/** The days axis: the first, middle and last day's short date; one or two days have no middle. */
export function dayTicks(times: readonly string[], date: (iso: string) => string): string[] {
  if (times.length === 0) return [];
  const last = times.length - 1;
  return [...new Set([0, ...(last >= 2 ? [Math.round(last / 2)] : []), last])].map((index) => date(times[index]!));
}

/** A selected bar's card: its title line and its rows. */
export interface ChartCard { title: string; rows: { kind: "cost" | "restart" | "context"; label: string; value: string }[] }

const count = (n: number): string => n.toLocaleString("en-US");

/** What the card above the plot says for `bar`. */
export function chartCard(bar: ChartBar, mode: ChartMode, t: Translate, timeZone?: string): ChartCard {
  const at = new Date(bar.at);
  const valid = !Number.isNaN(at.getTime());
  const calls = bar.calls === null ? null : t(bar.calls === 1 ? "1 call" : "{n} calls", { n: count(bar.calls) });
  const head = mode === "days"
    ? [valid ? at.toLocaleDateString(undefined, { timeZone, weekday: "short", month: "short", day: "numeric" }) : "", t(bar.replies === 1 ? "1 reply" : "{n} replies", { n: count(bar.replies) }), calls]
    : [t("Reply {n}", { n: bar.index + 1 }), valid ? `${at.toLocaleDateString(undefined, { timeZone, month: "short", day: "numeric" })}, ${at.toLocaleTimeString(undefined, { timeZone, hour: "2-digit", minute: "2-digit" })}` : "", calls];
  const rows: ChartCard["rows"] = [{ kind: "cost", label: t("Cost"), value: formatUsd(bar.rest + bar.restart) }];
  if (bar.restart > 0) {
    const label = mode === "days" && bar.restarts > 1 ? t("Cold restarts ({n})", { n: bar.restarts }) : t("Cold restart");
    rows.push({ kind: "restart", label, value: formatUsd(bar.restart) });
  }
  rows.push({ kind: "context", label: mode === "days" ? t("Largest context") : t("Context at the end"), value: cardTokens(bar.context) });
  return { title: head.filter((part): part is string => Boolean(part)).join(" · "), rows };
}

const storedMode = (): string | null => {
  try { return globalThis.localStorage?.getItem(MODE_KEY) ?? null; } catch { return null; }
};
const storeMode = (mode: ChartMode): void => {
  try { globalThis.localStorage?.setItem(MODE_KEY, mode); } catch { /* storage blocked: the mode is only not remembered */ }
};

/** the plot's height in the viewBox (and in px): the bars' scale */
const HEIGHT = 128;
/** the plot's width when it fits the card */
const WIDTH = 300;
/** a reply's slot when more than 40 scroll sideways */
const SCROLL_SLOT = 10;

export function CostChart({ messages, priced, timeZone }: { messages: readonly MessageCost[]; priced: boolean; timeZone?: string }) {
  const t = useT();
  const [chosen, setChosen] = useState<ChartMode | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const many = messages.length > DAYS_OVER;
  const mode = many ? chosen ?? chartMode(messages.length, storedMode()) : "replies";
  const scrolls = mode === "replies" && many;
  const bars: ChartBar[] = mode === "days" ? dayCosts(messages, timeZone) : messages.map((each, index) => ({ ...each, index, replies: 1 }));
  const last = bars.length - 1;
  const pick = selected !== null && selected <= last ? selected : null;
  // a tap anywhere outside the chart clears the card
  useEffect(() => {
    if (pick === null || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const away = (event: Event): void => {
      if (root.current && event.target instanceof Node && root.current.contains(event.target)) return;
      setSelected(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [pick]);
  // the replies scrolled sideways open at the latest
  useEffect(() => {
    const element = scroller.current;
    if (scrolls && element) element.scrollLeft = element.scrollWidth;
  }, [scrolls, bars.length]);
  if (messages.length === 0) return null;
  const totals = bars.map((each) => each.restart + each.rest);
  const usdTicks = niceTicks(Math.max(...totals));
  const contextTicks = niceTicks(Math.max(...bars.map((each) => each.context)));
  const top = usdTicks[usdTicks.length - 1]!;
  const peak = contextTicks[contextTicks.length - 1]!;
  const average = totals.reduce((sum, each) => sum + each, 0) / bars.length;
  const width = scrolls ? bars.length * SCROLL_SLOT : WIDTH;
  const slot = width / bars.length;
  const bar = Math.max(1, Math.min(8.5, slot * 0.62));
  const x = (index: number): number => index * slot + (slot - bar) / 2;
  const centre = (index: number): number => index * slot + slot / 2;
  const y = (value: number): number => HEIGHT - (value / top) * HEIGHT;
  const lineY = (context: number): number => HEIGHT - (context / peak) * HEIGHT;
  const line = bars.map((each, index) => `${index === 0 ? "M" : "L"}${centre(index).toFixed(1)},${lineY(each.context).toFixed(1)}`).join(" ");
  const clock = (iso: string): string => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(undefined, { timeZone, hour: "2-digit", minute: "2-digit" });
  };
  const date = (iso: string): string => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(undefined, { timeZone, month: "short", day: "numeric" });
  };
  const ticks = mode === "days" ? dayTicks(bars.map((each) => each.at), date) : chartTicks(bars.map((each) => each.at), clock, t("now"));
  const averageY = y(average);
  const card = pick === null ? null : chartCard(bars[pick]!, mode, t, timeZone);
  const choose = (next: ChartMode): void => { setChosen(next); storeMode(next); setSelected(null); setActive(null); };
  const select = (index: number | null): void => { setSelected(index); if (index !== null) setActive(index); };
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const from = active ?? pick ?? last;
    const move = (to: number): void => {
      event.preventDefault();
      const next = Math.max(0, Math.min(last, to));
      setActive(next);
      if (scrolls) scroller.current?.querySelector<HTMLElement>(`[data-bar="${next}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    if (event.key === "ArrowLeft") move(from - 1);
    else if (event.key === "ArrowRight") move(from + 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(last);
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(from); }
    else if (event.key === "Escape" && pick !== null) { event.preventDefault(); event.stopPropagation(); setSelected(null); }
  };
  const id = (index: number): string => `session-chart-bar-${index}`;
  const kicker = mode === "days" ? t("Per day · {n} replies", { n: count(messages.length) }) : t("Per reply");
  return <div className="session-chart" ref={root}>
    <div className="session-chart-head">
      <span className="session-kicker">{kicker}</span>
      {many
        ? <div className="segmented session-chart-mode" role="group" aria-label={t("Chart by")}>
          {(["replies", "days"] as const).map((each) => <button key={each} type="button" aria-pressed={mode === each} onClick={() => choose(each)}>{each === "days" ? t("Days") : t("Replies")}</button>)}
        </div>
        : priced && <span className="session-chart-avg">{t("avg")} <strong>{formatUsd(average)}</strong></span>}
    </div>
    <div className="session-chart-legend" aria-hidden="true">
      <span><i className="is-cost" />{t("Cost")} <small>{t("$ · left")}</small></span>
      <span><i className="is-restart" />{t("Cold restart")}</span>
      <span><i className="is-context" />{t("Context")} <small>{t("K · right")}</small></span>
    </div>
    {card && <div className="session-chart-card" role="status">
      <div className="session-chart-card-title">{card.title}</div>
      {card.rows.map((row) => <div key={row.kind} className="session-chart-card-row">
        <span><i className={`is-${row.kind}`} aria-hidden="true" />{row.label}</span><b>{row.value}</b>
      </div>)}
    </div>}
    <div className="session-chart-frame">
      <div className="session-chart-yaxis is-usd" aria-hidden="true">
        {usdTicks.map((tick) => <span key={tick} style={{ top: `${(y(tick) / HEIGHT) * 100}%` }}>{tickUsd(tick)}</span>)}
      </div>
      <div className={`session-chart-scroll${scrolls ? " is-scrolling" : ""}`} ref={scroller}>
        <div className="session-chart-plot" style={scrolls ? { width: `${width}px` } : undefined}>
          <svg className="session-chart-svg" viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            {usdTicks.map((tick) => <line key={tick} x1={0} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--border)" vectorEffect="non-scaling-stroke" />)}
            <line x1={0} x2={width} y1={averageY} y2={averageY} stroke="var(--text-dim)" strokeOpacity="0.5" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            {bars.map((each, index) => {
              const rest = (each.rest / top) * HEIGHT;
              const restart = (each.restart / top) * HEIGHT;
              const opacity = pick === null || pick === index ? 1 : 0.35;
              return <g key={index} opacity={opacity}>
                <rect x={x(index)} y={HEIGHT - rest} width={bar} height={rest} rx={1.5} fill="var(--status-working)" />
                {restart > 0 && <rect x={x(index)} y={HEIGHT - rest - restart} width={bar} height={restart} rx={1.5} fill="var(--status-blocked)" />}
              </g>;
            })}
            <path d={line} fill="none" stroke="var(--accent)" strokeOpacity="0.8" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
            {pick !== null && <line className="session-chart-guide" x1={centre(pick)} x2={centre(pick)} y1={0} y2={HEIGHT} stroke="var(--text)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
          </svg>
          <span className="session-chart-tag" style={{ top: `${(averageY / HEIGHT) * 100}%` }} aria-hidden="true">{t("avg")}</span>
          {pick !== null && <span className="session-chart-dot" aria-hidden="true" style={{ left: `${(centre(pick) / width) * 100}%`, top: `${(lineY(bars[pick]!.context) / HEIGHT) * 100}%` }} />}
          <div className="session-chart-hits" role="listbox" tabIndex={0} aria-label={mode === "days" ? t("Cost per day") : t("Cost per reply")}
            aria-activedescendant={active !== null && active <= last ? id(active) : undefined} onKeyDown={keys}>
            {bars.map((each, index) => <div key={index} id={id(index)} data-bar={index} role="option" aria-selected={pick === index}
              aria-label={`${chartCard(each, mode, t, timeZone).title} · ${formatUsd(each.rest + each.restart)}`}
              className={`session-chart-hit${active === index ? " is-active" : ""}`}
              style={{ left: `${(index / bars.length) * 100}%`, width: `${100 / bars.length}%` }}
              onClick={() => select(pick === index ? null : index)} />)}
          </div>
        </div>
        <div className="session-chart-axis" aria-hidden="true" style={scrolls ? { width: `${width}px` } : undefined}>{ticks.map((tick, index) => <span key={index}>{tick}</span>)}</div>
      </div>
      <div className="session-chart-yaxis is-context" aria-hidden="true">
        {contextTicks.map((tick) => <span key={tick} style={{ top: `${(lineY(tick) / HEIGHT) * 100}%` }}>{tickTokens(tick)}</span>)}
      </div>
    </div>
  </div>;
}
