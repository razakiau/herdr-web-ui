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
import { Flame } from "lucide-react";

import "./SessionSheet.css";

import type { HostChatCost, HostChatRead, HostContextUsage, HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMinuteClock } from "../lib/hostChats.ts";
import { formatUsd, isLocalModel, listUsd, priceWithFallback } from "../lib/chatCost.ts";
import { avgOutput, cacheMeter, cacheModel, callingModel, costSplit, FRESH_CHAT_CONTEXT, freshHandoffUsd, modelLastCall, handoffUsd, mergeLive, nextCall, renewedAt, writePrice, type CostSplit } from "../lib/sessionCost.ts";
import type { Settings } from "../lib/settings.ts";
import { keepWarmFeed, keepWarmFor, keptWarmOf, saveKeepWarm, useKeepWarm, withChat } from "../lib/keepWarm.ts";
import type { KeepWarmAnswer, KeepWarmKey } from "../../shared/keep-warm.ts";
import { ContextPanel, ContextSheet, formatTokenCount, SheetFrame } from "./HostChatStatus.tsx";
import { CostChart, messageCosts } from "./CostChart.tsx";
import { Toggle } from "./SettingsControls.tsx";
import { COST_PARTS, CostStack, Hero, partLabel } from "./CostParts.tsx";

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
  /** starts Hand off & continue; absent while the chat works without asking or when the session lists no handoff command */
  onHandoff?: (() => void) | undefined;
  /** the hand-off job runs: the button says so and waits */
  handingOff?: boolean;
  /** the chat works without asking (the bridge would answer busy): the button shows, disabled, saying so */
  handoffWaiting?: boolean;
  /** the hand-off goes from the chat's record (a cold or archived chat, ZAC-266): its price is the fresh path's; absent, a cold cache decides */
  fresh?: boolean;
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

/** what the chat's sums say, the live turn folded in, for both cost tabs */
function figures(props: SessionSheetProps, now: number, keepWarm: KeepWarmAnswer | null) {
  const { read, cost, prices, settings } = props;
  if (!cost?.chat) return null;
  const chat = mergeLive(cost.chat, read.tokens?.totals);
  const model = read.model?.id ?? cacheModel(chat);
  // kept warm by OmniRoute (phase 2): its pings renew the cache the CLI's log never sees
  // only the last call's model: the composer switched to another one stores it all again on that one
  const keep = !modelLastCall(chat, model).switched ? keepWarmFor(keepWarm, chat, now) : null;
  // the meter's and the banner's rule, kept warm included (ZAC-266), so the three never disagree
  const { context, cache, advised, switched } = cacheMeter(read, chat, settings, now, prices, keptWarmOf(keep));
  // `prices` null: not answered yet; an answer without tables prices nothing, so every model is missing
  const table = prices?.prices ?? {};
  const fallback = prices?.fallback ?? null;
  const avg = avgOutput(chat);
  const next = prices ? nextCall(context, model, avg, table, fallback) : null;
  const fresh = prices ? nextCall(FRESH_CHAT_CONTEXT, model, avg, table, fallback)?.warm ?? null : null;
  // what handing off costs now (shared/cache-cost.ts): by a note while warm (the window-end alert
  // quotes the same), by the old chat's record once cold or archived, as the button goes (ZAC-266)
  const handoff = prices ? ((props.fresh ?? cache?.state === "cold") ? freshHandoffUsd(model, avg, table, fallback) : handoffUsd(context, model, avg, table, fallback)) : null;
  const split = prices ? costSplit(chat.models, table, fallback) : null;
  const price = prices ? priceWithFallback(model, table, fallback)?.price ?? null : null;
  return { chat, context, cache, advised, switched, next, fresh, handoff, split, model, price, calls: cost.calls, keep };
}

export function SessionSheet(props: SessionSheetProps) {
  const t = useT();
  const clock = useMinuteClock();
  const now = props.now ?? clock;
  const [chosen, setChosen] = useState<Tab | null>(null);
  const { read, estimate, settings, onClose, onCompact } = props;
  const keepWarm = useKeepWarm(settings.trackCosts);
  const session = figures(props, now, keepWarm);
  const keep = session?.keep ?? null;
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
    : tab === "cache" ? <CacheTab {...props} session={session} keep={keep} keepWarm={keepWarm} now={now} />
    : <CostTab session={session} prices={props.prices ?? { prices: null, fallback: null }} />;
  return <SheetFrame label={t("Session")} title={t("Session")} className={`session-sheet${state ? ` is-${state}` : ""}`} head={tabs} onClose={onClose}>
    {body}
  </SheetFrame>;
}

type Session = NonNullable<ReturnType<typeof figures>>;

/**
 * The context window. While a turn runs the host reports no breakdown (`read.context` null), and a
 * chat driven by ask_user is one turn for hours: the split the CLI's log gives (`log.split`, bundle
 * 1071) is shown when it is newer than the last breakdown kept, else that one, its size the log's
 * when the log's last call is newer, each with a line saying where it comes from. Only a size: it
 * says so, without promising the turn will end. Nothing known at all: one line, never an empty tab.
 */
function ContextTab({ read, lastContext, cost, onClose, onCompact }: SessionSheetProps) {
  const t = useT();
  if (read.context) return <ContextPanel usage={read.context} cost={null} onClose={onClose} onCompact={onCompact} />;
  const log = cost?.chat ?? null;
  const logAt = log?.lastCallAt ? Date.parse(log.lastCallAt) : Number.NaN;
  const split = log?.split ?? null;
  if (split && split.systemTokens !== undefined && (!lastContext || !(logAt <= lastContext.at))) {
    return <>
      <ContextPanel usage={split} cost={null} onClose={onClose} onCompact={onCompact} />
      <p className="host-context-note session-context-note">{t("Breakdown from this chat's log, as of its last call.")}</p>
    </>;
  }
  if (lastContext) {
    const newer = log !== null && log.context !== null && logAt > lastContext.at;
    const usage = newer ? { ...lastContext.usage, currentTokens: log.context! } : lastContext.usage;
    return <>
      <ContextPanel usage={usage} cost={null} onClose={onClose} onCompact={onCompact} />
      <p className="host-context-note session-context-note">{t("Breakdown as of the last finished turn.")}</p>
    </>;
  }
  if (log?.context) return <p className="host-context-note">{t("{size} tokens; no breakdown reported while this turn runs.", { size: formatTokenCount(log.context) })}</p>;
  return <p className="host-context-note">{t("No context size yet.")}</p>;
}

const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The Cache tab's keep-warm row (phase 2): its switch, until when and today's pings; why it stopped
 * (a ping missed, past its window, the day's cap). On every chat the plugin knows (ZAC-267): a chat
 * under the mark is off by default and says why and what a ping costs; turned on, it says the owner did.
 */
function KeepWarmRow({ keep, answer, now }: { keep: { key: KeepWarmKey; kept: boolean }; answer: KeepWarmAnswer; now: number }) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const { key } = keep;
  const state = answer.state!;
  // a plugin before ZAC-267 listed big chats only, without the field
  const big = key.big !== false;
  // the saved settings, not the plugin's state: the plugin writes its state before it reads the
  // settings, so the state says the old choice for a sync or two and the switch snapped back (owner's
  // phone, ZAC-267: "I click, nothing happens"). The state's fields cover a settings answer without lists.
  const disabledNow = answer.settings.disabled ? answer.settings.disabled.includes(key.key) : key.disabled;
  const forcedNow = answer.settings.forced ? answer.settings.forced.includes(key.key) : key.forced === true;
  const chosen = big ? !disabledNow : forcedNow && !disabledNow;
  const on = state.enabled && chosen;
  const mark = formatUsd(state.thresholdUsd);
  // the chat's own window: one extended from the window-end alert ends later than the setting's hours
  const hours = Math.round((key.until - key.lastRealAt) / 3_600_000) || state.windowHours;
  const why = !state.enabled ? t("Off in Settings")
    : key.missed ? t("Stopped: a ping found the cache gone")
    : chosen && key.expired ? t("Cache already gone: kept from its next call")
    : now >= key.until ? t("Stopped {n} h after the last call", { n: hours })
    : state.today.fuseHit && !keep.kept ? t("Daily cap reached")
    : !chosen && big ? t("Off by you")
    : !chosen ? [t("Off: restart ~{usd} < {mark}", { usd: formatUsd(key.restartUsd), mark }), key.pingUsd ? t("a ping ~{usd}", { usd: formatUsd(key.pingUsd) }) : null].filter(Boolean).join(" · ")
    : null;
  const sub = [
    on && !why ? t("until {time} ({n} h after the last call)", { time: clockTime(key.until), n: hours }) : why,
    on && !why && !big ? t("on by you, under {mark}", { mark }) : null,
    key.pings === 1 ? t("1 ping today, ~{usd}", { usd: formatUsd(key.usd) }) : key.pings > 1 ? t("{n} pings today, ~{usd}", { n: key.pings, usd: formatUsd(key.usd) }) : null,
  ].filter(Boolean).join(" · ");
  const toggle = (next: boolean): void => {
    setSaving(true);
    void saveKeepWarm(withChat(answer.settings, key.key, next, big)).then((saved) => keepWarmFeed.set(saved), () => {}).finally(() => setSaving(false));
  };
  return <div className="host-context-row session-keep-warm">
    <span className="session-row-label"><span><Flame className="session-keep-flame" aria-hidden="true" />{t("Keep warm")}</span>{sub && <small className="session-row-sub">{sub}</small>}</span>
    <Toggle label={t("Keep warm")} checked={chosen} disabled={!answer.writable || !state.enabled || saving} onChange={toggle} />
  </div>;
}

function CacheTab(props: SessionSheetProps & { session: Session; keep: { key: KeepWarmKey; kept: boolean } | null; keepWarm: KeepWarmAnswer | null; now: number }) {
  const { read, session, settings, onClose, onCompact, onHandoff, handingOff, handoffWaiting, keep, keepWarm, now } = props;
  const kept = keep?.kept === true;
  const t = useT();
  const { cache, advised, switched, next, fresh, handoff, context } = session;
  const lastMain = [...session.calls].reverse().find((call) => call.main);
  // the last call's own hit: the message's sums mix in every call of its tool loop
  const hit = lastMain && lastMain.context > 0 ? Math.round((lastMain.lastCacheRead / lastMain.context) * 100) : null;
  const size = formatTokenCount(context);
  const ratio = next && next.warm > 0 ? Math.round(next.cold / next.warm) : null;
  const why = advised === "handoff-cold" ? t("The next call stores {size} again whatever you do. If work remains, a fresh chat is cheaper from the next reply on.", { size })
    : advised === "handoff-cooling" && cache ? [t("{size} is re-read on every call.", { size }), ratio ? t("The cache expires in {n} min; after that the next call costs about {ratio} warm ones.", { n: cache.leftMin, ratio }) : t("The cache expires in {n} min.", { n: cache.leftMin })].join(" ")
    : t("{size} is re-read on every call.", { size });
  // the composer's model has never been called in this chat: the chat's last call and its hit are another model's
  const unused = switched && modelLastCall(session.chat, session.model).lastCallAt === null;
  const when = cache === null ? null
    : unused ? t("No call on this model yet")
    : kept ? (keep.key.nextPingAt ? t("kept warm · next ping {time}", { time: clockTime(keep.key.nextPingAt) }) : t("kept warm"))
    : cache.state === "cold" ? `${agoText(cache.ageMin, t)} · ${t("expired")}`
    : `${agoText(cache.ageMin, t)} · ${t("{n} min left", { n: cache.leftMin })}`;
  // a chat working now keeps its cache warm: its countdown has not started (cacheState gives 0 left)
  const busy = callingModel(read);
  const left = cache === null || cache.state === "cold" ? 0 : busy ? 100 : Math.min(100, (cache.leftMin / settings.cacheLifetimeMin) * 100);
  const cold = cache?.state === "cold";
  // when the cache goes: its last renewal plus its lifetime, on the user's clock; for a kept chat the
  // renewal is its last call or ping, the later (ZAC-266: the last call alone went stale at each ping)
  const ownLast = modelLastCall(session.chat, session.model).lastCallAt ?? session.chat.lastCallAt;
  const lastAt = kept ? renewedAt(ownLast, keptWarmOf(keep)!) ?? Number.NaN : ownLast ? Date.parse(ownLast) : Number.NaN;
  const logDeadline = busy || !Number.isFinite(lastAt) ? null : clockTime(lastAt + settings.cacheLifetimeMin * 60_000);
  const deadline = cold || kept ? null : logDeadline;
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
        {cache && !unused && <div className="host-context-row session-countdown">
          <div className="session-cache-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left)} aria-label={t("Cache time left")}>
            <span className={`is-${cache.state}`} style={{ width: `${left}%` }} />
          </div>
          <div className="session-countdown-captions">
            <span>{busy ? t("Kept warm while working") : kept ? t("kept warm") : cache.state === "cold" ? t("expired") : t("{n} min left", { n: cache.leftMin })}</span>
            <span>{t(kept && !busy ? "Expires {n} min after the last call or ping" : "Expires {n} min after the last call", { n: settings.cacheLifetimeMin })}</span>
          </div>
        </div>}
        {keep && keepWarm?.state && !unused && <KeepWarmRow keep={keep} answer={keepWarm} now={now} />}
        {hit !== null && !unused && <div className="host-context-row"><span>{t("Last call read from cache")}</span><span className="session-value">{hit}%</span></div>}
        {/* cold: no warm price to have, the next call stores it all again; it is weighed against a fresh chat */}
        {/* the composer's model has no warm cache of this chat: the next call stores it all again on it, priced on it */}
        {next && cold && <div className="host-context-row">
          <span className="session-row-label">{t(switched ? "Model changed" : "Next call")}<small className="session-row-sub">{t(switched ? "the next call stores {size} again" : "stores {size} again", { size })}</small></span>
          <span className="session-value">{usd(next.cold, false)}</span>
        </div>}
        {next && cold && fresh !== null && <div className="host-context-row"><span>{t("In a fresh chat")}</span><span className="session-value">{t("{usd} per call", { usd: usd(fresh, false) })}</span></div>}
        {/* warm or cooling: now, and past the deadline; a working chat has none yet */}
        {next && !cold && <div className="host-context-row"><span>{t("Next call now")}</span><span className="session-value">{usd(next.warm, false)}</span></div>}
        {next && !cold && <div className="host-context-row"><span>{kept ? (logDeadline ? t("Without keep-warm, after {time}", { time: logDeadline }) : t("Without keep-warm")) : deadline ? t("If you wait past {time}", { time: deadline }) : t("After the cache expires")}</span><span className="session-value">{usd(next.cold, false)}</span></div>}
        {/* a big chat's way out: by a note while warm, from its record once cold (the cold alert's price, ZAC-266) */}
        {handoff !== null && advised !== "keep" && <div className="host-context-row"><span>{t("Hand off now")}</span><span className="session-value">{usd(handoff, false)}</span></div>}
      </div>
      {!next && props.prices && <p className="host-context-note">{t("No price for {models}.", { models: session.model || "?" })}</p>}
    </section>
    {(onHandoff || handingOff || handoffWaiting || onCompact) && <div className="session-sheet-actions">
      {handingOff ? <button type="button" className="btn" disabled>{t("Handing off…")}</button>
        : !onHandoff && handoffWaiting ? <button type="button" className="btn" disabled>{t("Working: hand off when it asks or stops")}</button>
        : onHandoff && <button type="button" className={`btn${advised !== "keep" ? " btn-primary" : ""}`} onClick={() => { onHandoff(); onClose(); }}>{t("Hand off & continue")}</button>}
      {onCompact && <button type="button" className="btn" onClick={() => { onCompact(); onClose(); }}>{t("Compact Conversation")}</button>}
    </div>}
  </>;
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
  const firstWrites = session.chat.firstWrites ?? 0;
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
        {/* the chat's first call stored the conversation with no cache to lose: a write, not a restart (ZAC-262) */}
        {firstWrites > 0 && <span className="session-cost-pill">
          <span className="cost-dot cost-part is-writes" aria-hidden="true" />
          {t(firstWrites === 1 ? "First write · {usd}" : "{n} first writes · {usd}", { n: firstWrites, usd: formatUsd(split.firstWrite) })}
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
