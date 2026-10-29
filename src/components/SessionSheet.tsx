/**
 * The Session sheet (ZAC-260): what the context meter opens while costs are tracked. Ovis's
 * segmented control over three tabs: Cache (how warm the prompt cache is, the advice, what the next
 * call costs, Hand off and Compact), Cost (the chat's cost at list price by what the money went on,
 * and per message) and Context (the context window sheet's content, unchanged). It opens on Cache
 * when the advice is a handoff, otherwise on the tab last used on this device. With tracking off
 * it is the context window sheet, as before.
 */
import { useState } from "react";

import "./SessionSheet.css";

import type { HostChatCost, HostChatRead, HostCostCall } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMinuteClock } from "../lib/hostChats.ts";
import { formatUsd, listUsd, priceWithFallback } from "../lib/chatCost.ts";
import { cacheMeter, costSplit, mergeLive, nextCall } from "../lib/sessionCost.ts";
import type { Settings } from "../lib/settings.ts";
import { ContextPanel, ContextSheet, formatTokenCount, SheetFrame } from "./HostChatStatus.tsx";
import { CostChart, messageCosts } from "./CostChart.tsx";

type Tab = "cache" | "cost" | "context";
const TABS: Tab[] = ["cache", "cost", "context"];
const TAB_KEY = "ovis:session-tab";

export interface SessionSheetProps {
  read: HostChatRead;
  /** today's estimate from the loaded turns, for the Context tab (and the sheet with tracking off) */
  estimate: { usd: number; partial: boolean; missing: string[]; estimated: string[] } | null;
  /** the bridge's answer for the chat (fetchChatCost): undefined while asked, null from a bridge that predates costs */
  cost: { chat: HostChatCost | null; calls: HostCostCall[] } | null | undefined;
  /** null until the price request answers; an answer with neither table (`{ prices: null, fallback: null }`) prices nothing */
  prices: { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null } | null;
  settings: Pick<Settings, "trackCosts" | "costHandoffAt" | "cacheLifetimeMin">;
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

/** what the chat's sums say, the live turn folded in, for both cost tabs */
function figures(props: SessionSheetProps, now: number) {
  const { read, cost, prices, settings } = props;
  if (!cost?.chat) return null;
  const chat = mergeLive(cost.chat, read.tokens?.totals);
  // the meter's and the banner's rule, so the three never disagree near the threshold
  const { context, cache, advised } = cacheMeter(read, chat, settings, now);
  const model = read.model?.id ?? [...chat.models].sort((a, b) => b.input - a.input)[0]?.model ?? "";
  const calls = chat.models.reduce((sum, each) => sum + each.calls, 0);
  const output = chat.models.reduce((sum, each) => sum + each.output, 0);
  // `prices` null: not answered yet; an answer without tables prices nothing, so every model is missing
  const table = prices?.prices ?? {};
  const fallback = prices?.fallback ?? null;
  const next = prices ? nextCall(context, model, calls > 0 ? output / calls : 0, table, fallback) : null;
  const split = prices ? costSplit(chat.models, table, fallback) : null;
  const price = prices ? priceWithFallback(model, table, fallback)?.price ?? null : null;
  return { chat, context, cache, advised, next, split, model, price, calls: cost.calls };
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
  const tab: Tab = chosen ?? (handoff ? "cache" : storedTab() ?? "cache");
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
    ? read.context ? <ContextPanel usage={read.context} cost={estimate} onClose={onClose} onCompact={onCompact} /> : null
    : props.cost === null ? <p className="host-context-note">{t("Update the bridge on this PC to show costs.")}</p>
    : props.cost === undefined || (tab === "cost" && props.prices === null && props.cost.chat !== null) ? <p className="host-context-note">{t("Loading…")}</p>
    : session === null ? <p className="host-context-note">{t("No calls in this chat's log yet.")}</p>
    : tab === "cache" ? <CacheTab {...props} session={session} />
    : <CostTab session={session} />;
  return <SheetFrame label={t("Session")} title={t("Session")} className={`session-sheet${state ? ` is-${state}` : ""}`} head={tabs} onClose={onClose}>
    {body}
  </SheetFrame>;
}

type Session = NonNullable<ReturnType<typeof figures>>;

function CacheTab(props: SessionSheetProps & { session: Session }) {
  const { read, session, settings, onClose, onCompact, onHandoff } = props;
  const t = useT();
  const { cache, advised, next, context } = session;
  const lastMain = [...session.calls].reverse().find((call) => call.main);
  // the last call's own hit: the message's sums mix in every call of its tool loop
  const hit = lastMain && lastMain.context > 0 ? Math.round((lastMain.lastCacheRead / lastMain.context) * 100) : null;
  const size = formatTokenCount(context);
  const ratio = next && next.warm > 0 ? Math.round(next.cold / next.warm) : null;
  const why = advised === "handoff-cold" ? t("The next call rewrites {size} whatever you do, so a fresh chat costs nothing extra.", { size })
    : advised === "handoff-cooling" && cache ? [t("{size} is re-read on every call.", { size }), ratio ? t("The cache expires in {n} min; after that the next call costs about {ratio} warm ones.", { n: cache.leftMin, ratio }) : t("The cache expires in {n} min.", { n: cache.leftMin })].join(" ")
    : t("{size} is re-read on every call.", { size });
  const when = cache === null ? null
    : cache.state === "cold" ? `${agoText(cache.ageMin, t)} · ${t("expired")}`
    : `${agoText(cache.ageMin, t)} · ${t("{n} min left", { n: cache.leftMin })}`;
  // a chat working now keeps its cache warm: its countdown has not started (cacheState gives 0 left)
  const busy = read.busy;
  const left = cache === null || cache.state === "cold" ? 0 : busy ? 100 : Math.min(100, (cache.leftMin / settings.cacheLifetimeMin) * 100);
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
        </div>}
        {hit !== null && <div className="host-context-row"><span>{t("Last call read from cache")}</span><span className="session-value">{hit}%</span></div>}
        {next && <div className="host-context-row"><span>{t("Next call now")}</span><span className="session-value">{usd(next.warm, false)}</span></div>}
        {next && <div className="host-context-row"><span>{t("Next call after expiry")}</span><span className="session-value">{usd(next.cold, false)}</span></div>}
      </div>
      {!next && props.prices && <p className="host-context-note">{t("No price for {models}.", { models: session.model || "?" })}</p>}
    </section>
    {(onHandoff || onCompact) && <div className="session-sheet-actions">
      {onHandoff && <button type="button" className={`btn${advised !== "keep" ? " btn-primary" : ""}`} onClick={() => { onHandoff(); onClose(); }}>{t("Hand off")}</button>}
      {onCompact && <button type="button" className="btn" onClick={() => { onCompact(); onClose(); }}>{t("Compact Conversation")}</button>}
    </div>}
  </>;
}

function CostTab({ session }: { session: Session }) {
  const t = useT();
  const split = session.split!;
  const floor = split.floor || session.chat.partial;
  const share = (value: number): string => split.usd > 0 ? `${Math.round((value / split.usd) * 100)}%` : "0%";
  const parts = [
    { key: "reads", label: t("Re-reading the context"), value: split.reads },
    { key: "writes", label: t("Cache rewrites"), value: split.writes },
    { key: "output", label: t("Answers"), value: split.output },
    { key: "fresh", label: t("Your messages, tool results"), value: split.fresh },
  ];
  const messages = messageCosts(session.calls, session.model, session.price);
  return <>
    <section className="host-picker-group" aria-labelledby="session-cost">
      <h3 className="host-picker-provider session-group-head" id="session-cost">
        <span>{t("This chat")}</span>
        <span>{t("{n} calls", { n: session.chat.models.reduce((sum, each) => sum + each.calls, 0) })}</span>
      </h3>
      <div className="host-picker-rows">
        <div className="host-context-row session-total">
          <div className="session-total-line"><span>{t("Cost at list price")}</span><strong className="host-context-cost">{usd(split.usd, floor)}</strong></div>
          <div className="session-stack" aria-hidden="true">
            {parts.map((part) => split.usd > 0 && part.value > 0 && <span key={part.key} className={`is-${part.key}`} style={{ width: `${(part.value / split.usd) * 100}%` }} />)}
          </div>
        </div>
        {parts.map((part) => <div key={part.key} className="host-context-row">
          <span><span className={`session-swatch is-${part.key}`} aria-hidden="true" />{part.label}</span>
          <span className="session-value">{formatUsd(part.value)} · {share(part.value)}</span>
        </div>)}
      </div>
      <p className="host-context-note">{[
        split.missing.length > 0 ? t("No price for {models}.", { models: split.missing.join(", ") }) : null,
        session.chat.partial ? t("The log is not fully read yet: at least this much.") : null,
      ].filter(Boolean).join(" ") || t("Cache writes priced at 2× input for Anthropic models, at input otherwise.")}</p>
    </section>
    {messages.length > 0 && <section className="host-picker-group" aria-labelledby="session-chart">
      <h3 className="host-picker-provider session-group-head" id="session-chart"><span>{t("Per message")}</span><span>{t("context ↗")}</span></h3>
      <div className="session-chart">
        <CostChart messages={messages} label={t("Cost per message you sent")} />
      </div>
      <p className="host-context-note">{t("One bar per message you sent. Red: the cache was written again, as after a pause past its lifetime. Dashed: the context size.")}</p>
    </section>}
  </>;
}
