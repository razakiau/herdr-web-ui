/**
 * The handoff nudge over a host chat's composer (ZAC-260, owner's "tinted pill + nudge banner"):
 * one line in the cache's tint while the advice is to hand off, "Cache cold · free moment to hand
 * off", with Hand off (when the session has a handoff command and is idle) and ✕. ✕ hides it for
 * that chat until the cache's state changes; kept in memory only, so a reload shows it again.
 */
import { useState } from "react";
import { X } from "lucide-react";

import type { HostChatCost, HostChatRead } from "../../shared/host-chats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMinuteClock } from "../lib/hostChats.ts";
import { cacheMeter, type CacheState } from "../lib/sessionCost.ts";
import type { Settings } from "../lib/settings.ts";
import "./SessionSheet.css";

/** the state each chat's banner was dismissed in, by `dismissKey` (PC and session) */
const dismissed = new Map<string, CacheState>();

export function dismissHandoff(key: string, state: CacheState): void {
  dismissed.set(key, state);
}

/** hidden for this state; a dismissal from another state is forgotten, so the state coming back shows it again */
function isDismissed(key: string, state: CacheState): boolean {
  const at = dismissed.get(key);
  if (at === undefined) return false;
  if (at === state) return true;
  dismissed.delete(key);
  return false;
}

export interface HandoffBannerProps {
  dismissKey: string;
  read: HostChatRead | null;
  /** the bridge's log for the chat (fetchChatCost's `.chat`): undefined while asked, null without one */
  log: HostChatCost | null | undefined;
  settings: Pick<Settings, "trackCosts" | "costHandoffAt" | "cacheLifetimeMin">;
  /** the minute clock, given by a test */
  now?: number;
  /** sends /handoff; absent while the chat works or when the session lists no handoff command */
  onHandoff?: (() => void) | undefined;
}

export function HandoffBanner({ dismissKey, read, log, settings, now, onHandoff }: HandoffBannerProps) {
  const t = useT();
  const locale = useLocale();
  const clock = useMinuteClock();
  const [, setHidden] = useState(0);
  if (read === null || !settings.trackCosts || !log) return null;
  const { cache, advised } = cacheMeter(read, log, settings, now ?? clock);
  if (cache === null || advised === "keep" || isDismissed(dismissKey, cache.state)) return null;
  const { state } = cache;
  const headline = t(state === "warm" ? "Hand off if work remains" : state === "cooling" ? "Hand off before it goes cold" : "Free moment to hand off");
  // the advice card's headline, run on after the state as the owner's mock has it
  const rest = headline.charAt(0).toLocaleLowerCase(locale) + headline.slice(1);
  return <div className={`checkpoint-bar handoff-bar is-${state}`} role="status">
    <span className="checkpoint-bar-text"><strong>{t(state === "warm" ? "Cache warm" : state === "cooling" ? "Cache cooling" : "Cache cold")}</strong> · {rest}</span>
    {onHandoff && <button type="button" className="btn btn-ghost checkpoint-bar-redo" onClick={onHandoff}>{t("Hand off")}</button>}
    <button type="button" className="icon-button handoff-bar-close" aria-label={t("Dismiss")} title={t("Dismiss")}
      onClick={() => { dismissHandoff(dismissKey, state); setHidden((n) => n + 1); }}>
      <X aria-hidden="true" />
    </button>
  </div>;
}
