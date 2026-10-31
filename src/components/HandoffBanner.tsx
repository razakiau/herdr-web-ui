/**
 * The handoff nudge over a host chat's composer (ZAC-260, owner's "tinted pill + nudge banner"):
 * one line in the cache's tint while the advice is to hand off, "Cache cold · free moment to hand
 * off", with Hand off & continue (when the session has a handoff command and is idle or waits on its
 * own question; while it works without asking, "Working: hand off when it asks or stops" as a muted line under the advice) and ✕. ✕ hides
 * it for that chat until the cache's state changes; kept in memory only, so a reload shows it again.
 * It also says why a hand-off did not go (ZAC-262: busy, an old bridge, no /resume line…), whatever
 * the advice: the tap was the user's, so the answer shows even where the advice would not.
 * On a cold chat a grey second line says the new chat reads this one's record (ZAC-266), and once
 * a hand-off opened a new chat its outcome line offers Open new chat and Archive this one: the old
 * chat neither jumps nor archives by itself.
 */
import { useState } from "react";
import { X } from "lucide-react";

import type { HostChatCost, HostChatRead } from "../../shared/host-chats.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { HandoffStep } from "./HandoffStep.tsx";
import { useMinuteClock } from "../lib/hostChats.ts";
import { cacheMeter, type CachePrices, type CacheState, type KeptWarm } from "../lib/sessionCost.ts";
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
  settings: Pick<Settings, "trackCosts" | "coldRestartAlertUsd" | "cacheLifetimeMin">;
  /** the prices a big chat is weighed with (ZAC-260): null until they are in, and nothing is big then */
  prices: CachePrices | null;
  /** the minute clock, given by a test */
  now?: number;
  /** starts Hand off & continue; absent while the chat works without asking or when the session lists no handoff command */
  onHandoff?: ((message?: string) => void) | undefined;
  /** the hand-off job runs: the button says so and waits */
  handingOff?: boolean;
  /** the chat works without asking (the bridge would answer busy): the button shows, disabled, saying so */
  handoffWaiting?: boolean;
  /** why the last hand-off did not open a new chat (handOffAndContinue's line) */
  note?: string | null;
  onCloseNote?: () => void;
  /** the chat hands off from its record (cold, or archived): the grey second line under the advice */
  cold?: boolean;
  /** a hand-off opened a new chat: the outcome line, whatever the advice; ✕ is onCloseNote */
  outcome?: { mode: "note" | "fresh"; onOpen(): void; onArchive?: (() => void) | undefined } | null;
  /** OmniRoute keeps the chat warm now (ZAC-266): warm advice, never "Cache cold" */
  kept?: KeptWarm | null;
}

export function HandoffBanner({ dismissKey, read, log, settings, prices, now, onHandoff, handingOff = false, handoffWaiting = false, note = null, onCloseNote, cold = false, outcome = null, kept = null }: HandoffBannerProps) {
  const t = useT();
  const [step, setStep] = useState(false);
  const locale = useLocale();
  const clock = useMinuteClock();
  const [, setHidden] = useState(0);
  const noteOnly = note === null ? null : <div className="checkpoint-bar handoff-bar handoff-note" role="status">
    <span className="checkpoint-bar-text">{note}</span>
    <button type="button" className="icon-button handoff-bar-close" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={onCloseNote}>
      <X aria-hidden="true" />
    </button>
  </div>;
  if (outcome) return <div className="checkpoint-bar handoff-bar handoff-outcome" role="status">
    <span className="checkpoint-bar-text">{t(outcome.mode === "fresh"
      ? "Continued in a new chat from this chat's record. This one is stopped, not archived."
      : "Continued in a new chat from a hand-off note. This one is not archived.")}</span>
    <button type="button" className="btn btn-primary checkpoint-bar-redo" onClick={outcome.onOpen}>{t("Open new chat")}</button>
    {/* absent on a chat already archived */}
    {outcome.onArchive && <button type="button" className="btn btn-ghost checkpoint-bar-redo" onClick={outcome.onArchive}>{t("Archive this one")}</button>}
    <button type="button" className="icon-button handoff-bar-close" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={onCloseNote}>
      <X aria-hidden="true" />
    </button>
  </div>;
  if (read === null || !settings.trackCosts || !log) return noteOnly;
  const { cache, advised } = cacheMeter(read, log, settings, now ?? clock, prices, kept);
  if (cache === null || advised === "keep" || isDismissed(dismissKey, cache.state)) return noteOnly;
  const { state } = cache;
  const headline = t(state === "warm" ? "Hand off if work remains" : state === "cooling" ? "Hand off before it goes cold" : "Free moment to hand off");
  // the advice card's headline, run on after the state as the owner's mock has it
  const rest = headline.charAt(0).toLocaleLowerCase(locale) + headline.slice(1);
  // the message step (ZAC-267) opens under the advice, full width; Hand off and ✕ give it the room
  const stepping = step && onHandoff !== undefined;
  return <div className={`checkpoint-bar handoff-bar is-${state}${stepping ? " is-step" : ""}`} role="status">
    <span className="checkpoint-bar-text"><strong>{t(state === "warm" ? "Cache warm" : state === "cooling" ? "Cache cooling" : "Cache cold")}</strong> · {rest}
      {cold && <span className="handoff-bar-wait">{t("The new chat reads this one's record; nothing to re-read here")}</span>}
      {/* its own muted line: as a disabled button it squeezed the advice into a narrow column on a phone */}
      {handoffWaiting && !onHandoff && !handingOff && <span className="handoff-bar-wait">{t("Working: hand off when it asks or stops")}</span>}
    </span>
    {note !== null && <span className="checkpoint-bar-error" role="alert">{note}</span>}
    {!stepping && (onHandoff || handingOff) && <button type="button" className="btn btn-ghost checkpoint-bar-redo" disabled={handingOff} onClick={() => setStep(true)}>
      {t(handingOff ? "Handing off…" : "Hand off & continue")}
    </button>}
    {!stepping && <button type="button" className="icon-button handoff-bar-close" aria-label={t("Dismiss")} title={t("Dismiss")}
      onClick={() => { dismissHandoff(dismissKey, state); onCloseNote?.(); setHidden((n) => n + 1); }}>
      <X aria-hidden="true" />
    </button>}
    {stepping && <HandoffStep onSend={(message) => { setStep(false); onHandoff(message); }} onCancel={() => setStep(false)} />}
  </div>;
}
