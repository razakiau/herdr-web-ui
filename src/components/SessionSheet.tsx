/**
 * The Session sheet (ZAC-260): what the context meter opens while costs are tracked. Ovis's
 * segmented control over three tabs, in the owner's order: Context (the context window sheet's
 * content; while the chat works, the last finished turn's breakdown with the live size), Cost (the
 * chat's cost at list price by what the money went on, the rates behind ⓘ, and per reply) and Cache
 * (how warm the prompt cache is, the advice, what the next call costs, Hand off and Compact). It
 * opens on Cache when the advice is a handoff, otherwise on the tab last used on this device,
 * otherwise on Context. With tracking off it is the context window sheet, as before.
 */
import { useState } from "react";

import "./SessionSheet.css";

import type { HostChatCost, HostChatRead, HostContextUsage, HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMinuteClock } from "../lib/hostChats.ts";
import { formatUsd, isLocalModel, listUsd, priceWithFallback } from "../lib/chatCost.ts";
import { avgOutput, cacheMeter, callingModel, chatModel, costSplit, handoffUsd, mergeLive, nextCall, writePrice, type CostSplit } from "../lib/sessionCost.ts";
import type { Settings } from "../lib/settings.ts";
import { ContextPanel, ContextSheet, formatTokenCount, SheetFrame } from "./HostChatStatus.tsx";
import { CostChart, messageCosts } from "./CostChart.tsx";
import { COST_PARTS, CostStack, partLabel } from "./CostParts.tsx";

type Tab = "context" | "cost" | "cache";
const TABS: Tab[] = ["context", "cost", "cache"];
const TAB_KEY = "ovis:session-tab";

export interface SessionSheetProps {
  read: HostChatRead;
  /**
   * the last context breakdown the chat gave (HostChatView keeps it per chat), for the Context tab
   * while the chat works: the bridge reads none then. `at`: when it was kept (ms)
   */
  lastContext?: { usage: HostContextUsage; at: number } | null;
  /** today's estimate from the loaded turns, for the sheet with tracking off (the Cost tab has the log's) */
  estimate: { usd: number; partial: boolean; missing: string[]; estimated: string[] } | null;
  /** the bridge's answer for the chat (fetchChatCost): undefined while asked, null from a bridge that predates costs */
  cost: { chat: HostChatCost | null; calls: HostCostCall[] } | null | undefined;
  /** null until the price request answers; an answer with neither table (`{ prices: null, fallback: null }`) prices nothing */
  prices: { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null } | null;
  settings: Pick<Settings, "trackCosts" | "coldRestartAlertUsd" | "cacheLifetimeMin">;
  /** the minute clock (useMinuteClock), given by a test */
  now?: number;
  onClose(): void;
  /** sends /compact; absent while the chat works */
  onCompact?: (() => void) | undefined;
  /** sends /handoff; absent while the chat works or when the session lists no handoff command */
  onHandoff?: (() => void) | undefined;
}

const storedTab = (): Tab | null => {
  try {
    const value = globalThis.localStorage?.getItem(TAB_KEY);
    return TABS.includes(value as Tab) ? value as Tab : null;
  } catch { return null; }
};
const storeTab = (tab: Tab): void => {
  try { globalThis.localStorage?.setItem(TAB_KEY, tab); } catch { /* storage blocked: the tab is only not remembered */ }
};

/** "48 min ago", "2 h ago" */
const agoText = (minutes: number, t: Translate): string => minutes >= 60 ? t("{n} h ago", { n: Math.floor(minutes / 60) }) : t("{n} min ago", { n: minutes });

/** a price as an estimate ("~$0.11") or, when something is not counted, a floor rounded down like the lists print it ("≥ $149") */
const usd = (value: number, floor: boolean): string => floor ? listUsd(value, true) : `~${formatUsd(value)}`;

/**
 * A new chat's prompt at its first call: the system prompt and the tool definitions. Measured on the
 * owner's chats (ZAC-260, 2026-10-30): they start at ~65-75K. "In a fresh chat" prices one call at
 * it, read warm, plus the chat's average output.
 */
const FRESH_CHAT_CONTEXT = 70_000;

/** what the chat's sums say, the live turn folded in, for both cost tabs */
function figures(props: SessionSheetProps, now: number) {
  const { read, cost, prices, settings } = props;
  if (!cost?.chat) return null;
  const chat = mergeLive(cost.chat, read.tokens?.totals);
  // the meter's and the banner's rule, so the three never disagree near the threshold
  const { context, cache, advised } = cacheMeter(read, chat, settings, now, prices);
  const model = read.model?.id ?? chatModel(chat);
  // `prices` null: not answered yet; an answer without tables prices nothing, so every model is missing
  const table = prices?.prices ?? {};
  const fallback = prices?.fallback ?? null;
  const avg = avgOutput(chat);
  const next = prices ? nextCall(context, model, avg, table, fallback) : null;
  const fresh = prices ? nextCall(FRESH_CHAT_CONTEXT, model, avg, table, fallback)?.warm ?? null : null;
  // what /handoff costs now, warm: the server's cold alert quotes the same (shared/cache-cost.ts)
  const handoff = prices ? handoffUsd(context, model, avg, table, fallback) : null;
  const split = prices ? costSplit(chat.models, table, fallback) : null;
  const price = prices ? priceWithFallback(model, table, fallback)?.price ?? null : null;
  return { chat, context, cache, advised, next, fresh, handoff, split, model, price, calls: cost.calls };
}

export function SessionSheet(props: SessionSheetProps) {
  const t = useT();
  const clock = useMinuteClock();
  const now = props.now ?? clock;
  const [chosen, setChosen] = useState<Tab | null>(null);
  const { read, estimate, settings, onClose, onCompact } = props;
  const session = figures(props, now);
  if (!settings.trackCosts) return read.context ? <ContextSheet usage={read.context} cost={estimate} onClose={onClose} onCompact={onCompact} /> : null;
  const handoff = session !== null && session.advised !== "keep";
  const tab: Tab = chosen ?? (handoff ? "cache" : storedTab() ?? "context");
  const pick = (next: Tab): void => { setChosen(next); storeTab(next); };
  const state = session?.cache?.state ?? null;
  const label: Record<Tab, string> = { cache: t("Cache"), cost: t("Cost"), context: t("Context") };
  const tabs = <div className="session-tabs-bar">
    <div className="segmented session-tabs" role="group" aria-label={t("Session")}>
      {TABS.map((each) => <button key={each} type="button" aria-pressed={tab === each} onClick={() => pick(each)}>
        {each === "cache" && state && <span className={`session-dot is-${state}`} aria-hidden="true" />}{label[each]}
      </button>)}
    </div>
  </div>;
  const body = tab === "context"
    ? <ContextTab {...props} />
    : props.cost === null ? <p className="host-context-note">{t("Update the bridge on this PC to show costs.")}</p>
    : props.cost === undefined || (tab === "cost" && props.prices === null && props.cost.chat !== null) ? <p className="host-context-note">{t("Loading…")}</p>
    : session === null ? <p className="host-context-note">{t("No calls in this chat's log yet.")}</p>
    : tab === "cache" ? <CacheTab {...props} session={session} />
    : <CostTab session={session} prices={props.prices ?? { prices: null, fallback: null }} />;
  return <SheetFrame label={t("Session")} title={t("Session")} className={`session-sheet${state ? ` is-${state}` : ""}`} head={tabs} onClose={onClose}>
    {body}
  </SheetFrame>;
}

type Session = NonNullable<ReturnType<typeof figures>>;

/**
 * The context window. While the chat works the bridge reads no breakdown (`read.context` null): the
 * last one kept is shown, its size the log's when the log's last call is newer, with a line saying
 * so. Nothing known at all: one line, never an empty tab.
 */
function ContextTab({ read, lastContext, cost, onClose, onCompact }: SessionSheetProps) {
  const t = useT();
  if (read.context) return <ContextPanel usage={read.context} cost={null} onClose={onClose} onCompact={onCompact} />;
  const log = cost?.chat ?? null;
  if (lastContext) {
    const newer = log !== null && log.context !== null && log.lastCallAt !== null && Date.parse(log.lastCallAt) > lastContext.at;
    const usage = newer ? { ...lastContext.usage, currentTokens: log.context! } : lastContext.usage;
    return <>
      <ContextPanel usage={usage} cost={null} onClose={onClose} onCompact={onCompact} />
      <p className="host-context-note session-context-note">{t("Breakdown as of the last finished turn.")}</p>
    </>;
  }
  if (log?.context) return <p className="host-context-note">{t("{size} tokens; the breakdown comes when the turn ends.", { size: formatTokenCount(log.context) })}</p>;
  return <p className="host-context-note">{t("No context size yet.")}</p>;
}

function CacheTab(props: SessionSheetProps & { session: Session }) {
  const { read, session, settings, onClose, onCompact, onHandoff } = props;
  const t = useT();
  const { cache, advised, next, fresh, handoff, context } = session;
  const lastMain = [...session.calls].reverse().find((call) => call.main);
  // the last call's own hit: the message's sums mix in every call of its tool loop
  const hit = lastMain && lastMain.context > 0 ? Math.round((lastMain.lastCacheRead / lastMain.context) * 100) : null;
  const size = formatTokenCount(context);
  const ratio = next && next.warm > 0 ? Math.round(next.cold / next.warm) : null;
  const why = advised === "handoff-cold" ? t("The next call stores {size} again whatever you do. If work remains, a fresh chat is cheaper from the next reply on.", { size })
    : advised === "handoff-cooling" && cache ? [t("{size} is re-read on every call.", { size }), ratio ? t("The cache expires in {n} min; after that the next call costs about {ratio} warm ones.", { n: cache.leftMin, ratio }) : t("The cache expires in {n} min.", { n: cache.leftMin })].join(" ")
    : t("{size} is re-read on every call.", { size });
  const when = cache === null ? null
    : cache.state === "cold" ? `${agoText(cache.ageMin, t)} · ${t("expired")}`
    : `${agoText(cache.ageMin, t)} · ${t("{n} min left", { n: cache.leftMin })}`;
  // a chat working now keeps its cache warm: its countdown has not started (cacheState gives 0 left)
  const busy = callingModel(read);
  const left = cache === null || cache.state === "cold" ? 0 : busy ? 100 : Math.min(100, (cache.leftMin / settings.cacheLifetimeMin) * 100);
  const cold = cache?.state === "cold";
  // when the cache goes: the last call plus its lifetime, on the user's clock
  const lastAt = session.chat.lastCallAt ? Date.parse(session.chat.lastCallAt) : Number.NaN;
  const deadline = busy || cold || !Number.isFinite(lastAt) ? null
    : new Date(lastAt + settings.cacheLifetimeMin * 60_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return <>
    {advised !== "keep" && <div className="session-advice" role="note">
      <strong>{t(advised === "handoff-warm" ? "Hand off if work remains" : advised === "handoff-cooling" ? "Hand off before it goes cold" : "Free moment to hand off")}</strong>
      <span>{why}</span>
    </div>}
    <section className="host-picker-group" aria-labelledby="session-cache">
      <h3 className="host-picker-provider" id="session-cache">{t("Cache")}</h3>
      <div className="host-picker-rows">
        {cache && <div className="host-context-row">
          <span className="session-state"><span className={`session-dot is-${cache.state}`} aria-hidden="true" />{t(cache.state === "warm" ? "Warm" : cache.state === "cooling" ? "Cooling" : "Cold")}</span>
          <span className="session-value">{busy ? t("Working now") : when}</span>
        </div>}
        {cache && <div className="host-context-row session-countdown">
          <div className="session-cache-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)} aria-label={t("Cache time left")}>
            <span className={`is-${cache.state}`} style={{ width: `${left}%` }} />
          </div>
          <div className="session-countdown-captions">
            <span>{busy ? t("Kept warm while working") : cache.state === "cold" ? t("expired") : t("{n} min left", { n: cache.leftMin })}</span>
            <span>{t("Expires {n} min after the last call", { n: settings.cacheLifetimeMin })}</span>
          </div>
        </div>}
        {hit !== null && <div className="host-context-row"><span>{t("Last call read from cache")}</span><span className="session-value">{hit}%</span></div>}
        {/* cold: no warm price to have, the next call stores it all again; it is weighed against a fresh chat */}
        {next && cold && <div className="host-context-row">
          <span className="session-row-label">{t("Next call")}<small className="session-row-sub">{t("stores {size} again", { size })}</small></span>
          <span className="session-value">{usd(next.cold, false)}</span>
        </div>}
        {next && cold && fresh !== null && <div className="host-context-row"><span>{t("In a fresh chat")}</span><span className="session-value">{t("{usd} per call", { usd: usd(fresh, false) })}</span></div>}
        {/* warm or cooling: now, and past the deadline; a working chat has none yet */}
        {next && !cold && <div className="host-context-row"><span>{t("Next call now")}</span><span className="session-value">{usd(next.warm, false)}</span></div>}
        {next && !cold && <div className="host-context-row"><span>{deadline ? t("If you wait past {time}", { time: deadline }) : t("After the cache expires")}</span><span className="session-value">{usd(next.cold, false)}</span></div>}
        {/* a big chat's way out while it is warm: the price the cold alert quotes too */}
        {handoff !== null && advised !== "keep" && !cold && <div className="host-context-row"><span>{t("Hand off now")}</span><span className="session-value">{usd(handoff, false)}</span></div>}
      </div>
      {!next && props.prices && <p className="host-context-note">{t("No price for {models}.", { models: session.model || "?" })}</p>}
    </section>
    {(onHandoff || onCompact) && <div className="session-sheet-actions">
      {onHandoff && <button type="button" className={`btn${advised !== "keep" ? " btn-primary" : ""}`} onClick={() => { onHandoff(); onClose(); }}>{t("Hand off")}</button>}
      {onCompact && <button type="button" className="btn" onClick={() => { onCompact(); onClose(); }}>{t("Compact Conversation")}</button>}
    </div>}
  </>;
}

/** "$57.10" as the total card prints it: "$" and the cents small and dim, whole dollars large; a floor's cents rounded down */
function Hero({ usd, floor }: { usd: number; floor: boolean }) {
  const cents = Math.floor(usd * 100 + (floor ? 1e-9 : 0.5));
  const whole = Math.floor(cents / 100);
  return <div className="session-hero">
    {floor && <span className="session-hero-floor">≥</span>}
    <span className="session-hero-dollar">$</span>
    <span className="session-hero-whole">{whole.toLocaleString("en-US")}</span>
    <span className="session-hero-cents">.{String(cents % 100).padStart(2, "0")}</span>
  </div>;
}

/** The rates the chat's models are priced at, per million tokens; a local model "local · $0". */
function Rates({ split, models, prices, t }: { split: CostSplit; models: readonly string[]; prices: { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null }; t: Translate }) {
  const rate = (value: number): string => `$${value < 1 ? value.toFixed(2).replace(/0$/, "") : String(Math.round(value * 100) / 100)}`;
  return <div className="session-rates" id="session-rates">
    <ul className="session-rates-lines">
      <li>{t("Every call re-sends the whole conversation. The cache keeps it for 1 hour after the last call.")}</li>
      <li>{t("Re-reading: the conversation read back from the cache, on every call.")}</li>
      <li>{t("Storing new text: each call's new part, put in the cache.")}</li>
      <li>{t("Cold restarts: after more than an hour without a call, the whole conversation is stored again.")}</li>
      <li>{t("Answers: what the model writes. New input: the rest of a call, sent without the cache.")}</li>
    </ul>
    <div className="session-rates-table" role="table" aria-label={t("Rates per million tokens")}>
      <div role="row" className="is-head"><span role="columnheader" /><span role="columnheader">{t("in")}</span><span role="columnheader">{t("cached")}</span><span role="columnheader">{t("write")}</span><span role="columnheader">{t("out")}</span></div>
      {models.map((model) => {
        const name = model.slice(model.lastIndexOf("/") + 1);
        if (split.local.includes(model)) return <div role="row" key={model}><b role="cell">{name}</b><span role="cell" className="is-wide">{t("local · $0")}</span></div>;
        const found = priceWithFallback(model, prices.prices ?? {}, prices.fallback);
        if (!found) return <div role="row" key={model}><b role="cell">{name}</b><span role="cell" className="is-wide">{t("no price")}</span></div>;
        const { price } = found;
        return <div role="row" key={model}><b role="cell">{name}</b><span role="cell">{rate(price.input)}</span><span role="cell">{rate(price.cached ?? price.input)}</span><span role="cell">{rate(writePrice(model, price.input))}</span><span role="cell">{rate(price.output)}</span></div>;
      })}
    </div>
    <p className="session-rates-foot">{t("Per million tokens. Writes at 2× input for Anthropic models (their 1-hour cache rate), at input otherwise.")}</p>
  </div>;
}

function CostTab({ session, prices }: { session: Session; prices: { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null } }) {
  const t = useT();
  const [rates, setRates] = useState(false);
  const split = session.split!;
  const floor = split.floor || session.chat.partial;
  const share = (value: number): string => split.usd > 0 ? `${Math.round((value / split.usd) * 100)}%` : "0%";
  // Re-reading and Answers always; the others only when they cost something
  const parts = COST_PARTS.filter((part) => part === "reads" || part === "output" || split[part] > 0);
  const messages = messageCosts(session.calls, session.model, session.price);
  const calls = session.chat.models.reduce((sum, each) => sum + each.calls, 0);
  const restarts = session.chat.rewrites;
  const models = [...session.chat.models].sort((a, b) => b.input - a.input).map((each) => each.model);
  const problems = [
    split.missing.length > 0 ? t("No price for {models}.", { models: split.missing.join(", ") }) : null,
    session.chat.partial ? t("The log is not fully read yet: at least this much.") : null,
  ].filter(Boolean).join(" ");
  return <>
    <section className="session-card session-cost-card" aria-labelledby="session-cost">
      <h3 className="session-kicker" id="session-cost">{t("This chat · at list price")}</h3>
      <Hero usd={split.usd} floor={floor} />
      <CostStack split={split} className="session-stack" />
      <ul className="session-parts">
        {parts.map((part) => <li key={part} className="session-part">
          <span className="session-part-label"><span className={`cost-dot cost-part is-${part}`} aria-hidden="true" />{partLabel(part, t)}</span>
          <span className="session-part-value"><span className="session-part-usd">{formatUsd(split[part])}</span><span className="session-part-share">{share(split[part])}</span></span>
        </li>)}
      </ul>
      <div className="session-cost-pills">
        {restarts > 0 && <span className="session-cost-pill is-restart">
          <span className="cost-dot cost-part is-restarts" aria-hidden="true" />
          {split.restarts > 0
            ? t(restarts === 1 ? "1 cold restart · {usd}" : "{n} cold restarts · {usd}", { n: restarts, usd: formatUsd(split.restarts) })
            : t(restarts === 1 ? "1 cold restart" : "{n} cold restarts", { n: restarts })}
        </span>}
        <span className="session-cost-pill">{t(messages.length === 1 ? "{calls} calls · 1 reply" : "{calls} calls · {replies} replies", { calls, replies: messages.length })}</span>
        {split.local.length > 0 && <span className="session-cost-pill">{t("local models $0")}</span>}
        <button type="button" className="session-cost-pill is-button" aria-expanded={rates} aria-controls="session-rates" onClick={() => setRates(!rates)}>{t("Rates")} <span aria-hidden="true">ⓘ</span></button>
      </div>
      {problems && <p className="host-context-note session-card-note">{problems}</p>}
    </section>
    {rates && <Rates split={split} models={models} prices={prices} t={t} />}
    {/* a local model's replies cost $0 each: a row of empty bars and "avg $0.00" say nothing */}
    {messages.length > 0 && !isLocalModel(session.model) && <section className="session-card" aria-label={t("Per reply")}>
      <CostChart messages={messages} priced={session.price !== null} />
    </section>}
  </>;
}
