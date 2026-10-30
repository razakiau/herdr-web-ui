/**
 * The "This week" page (ZAC-262, owner's mockup B, phone first): what the weekly digest saved on
 * Sunday 19:00, shown as stored, never recomputed, so it says what the notification that opened it
 * said (shared/digest.ts `digestUsd` prints both). The range at list price; the total as the Cost
 * tab's hero; how it moved since the week before; a bar a day, its cold-restart part in the restart
 * colour (SessionSheet.css `.cost-part`); the week's pills; the costliest chats, a tap opening the
 * chat; keep-warm's pings, the restarts they avoided and the net saved. The arrows, or a sideways
 * swipe, go through the saved weeks. Days are UTC days, the bridge's keys: the first and last week
 * may have fewer than seven.
 */
import { useRef, useState, type TouchEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import "./SessionSheet.css";
import "./WeekSheet.css";

import { digestUsd, type DigestSnapshot } from "../../shared/digest.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useWeekDigest, weekDigest } from "../lib/weekDigest.ts";
import { Hero } from "./CostParts.tsx";
import { SheetFrame } from "./HostChatStatus.tsx";

export interface WeekSheetProps {
  /** the saved weeks, newest first (GET /api/costs/digests); null while they are read */
  digests: readonly DigestSnapshot[] | null;
  /** the week to open on (a digest's tap); null: the newest */
  week: string | null;
  onOpenChat(target: { machineId: string; session: string }): void;
  onClose(): void;
}

/** a sideways stroke longer than this, and more sideways than down, turns the week */
const SWIPE_PX = 48;

const utcDate = (ms: number, locale: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(ms);

export function WeekSheet({ digests, week, onOpenChat, onClose }: WeekSheetProps) {
  const t = useT();
  const [shown, setShown] = useState<string | null>(week);
  const stroke = useRef<{ x: number; y: number } | null>(null);
  const current = shown ?? digests?.[0]?.week ?? null;
  const index = digests?.findIndex((each) => each.week === current) ?? -1;
  const snapshot = index >= 0 ? digests![index]! : null;
  const older = index >= 0 ? digests![index + 1] ?? null : null;
  const newer = index > 0 ? digests![index - 1]! : null;
  const go = (to: DigestSnapshot | null): void => { if (to) setShown(to.week); };
  const swipe = {
    onTouchStart: (event: TouchEvent) => { const touch = event.touches[0]; stroke.current = touch ? { x: touch.clientX, y: touch.clientY } : null; },
    onTouchEnd: (event: TouchEvent) => {
      const start = stroke.current; const touch = event.changedTouches[0];
      stroke.current = null;
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(touch.clientY - start.y)) return;
      // the finger pulls the next page in: leftwards the newer week, rightwards the older
      go(dx < 0 ? newer : older);
    },
  };

  const body = digests === null ? <p className="host-context-note">{t("Loading…")}</p>
    : digests.length === 0 ? <p className="host-context-note">{t("No weekly digest yet: the first comes on Sunday at 19:00.")}</p>
    : snapshot === null ? <p className="host-context-note">{t("No digest for that week.")}</p>
    : <Week snapshot={snapshot} previous={older} hasNewer={newer !== null} onOlder={() => go(older)} onNewer={() => go(newer)} onOpenChat={onOpenChat} />;
  return <SheetFrame label={t("This week")} title={t("This week")} className="session-sheet week-sheet" onClose={onClose}>
    <div className="week-body" {...swipe}>{body}</div>
  </SheetFrame>;
}

function Week({ snapshot: s, previous, hasNewer, onOlder, onNewer, onOpenChat }: {
  snapshot: DigestSnapshot; previous: DigestSnapshot | null; hasNewer: boolean;
  onOlder(): void; onNewer(): void; onOpenChat(target: { machineId: string; session: string }): void;
}) {
  const t = useT();
  const locale = useLocale();
  const day = (ms: number): string => utcDate(ms, locale, { month: "short", day: "numeric" });
  const range = t("{from} – {to} · at list price", { from: day(Date.parse(s.week)), to: day(s.cut) });
  // as the notification says it: no arrow the first week, nor when the dollars come out the same
  const delta = previous ? s.total.usd - previous.total.usd : 0;
  const moved = previous && digestUsd(delta) !== digestUsd(0) ? t("{delta} vs last week", { delta: `${delta > 0 ? "▲" : "▼"} ${digestUsd(delta)}` }) : null;
  const chats = s.pcs.reduce((sum, pc) => sum + pc.chats, 0);
  const spread = t("{chats} on {pcs}", { chats: t(chats === 1 ? "1 chat" : "{n} chats", { n: chats }), pcs: t(s.pcs.length === 1 ? "1 PC" : "{n} PCs", { n: s.pcs.length }) });
  const nameOf = (machineId: string): string => s.pcs.find((pc) => pc.machineId === machineId)?.name ?? machineId;
  const saved = s.keepWarm.avoidedUsd - s.keepWarm.usd;
  const top = Math.max(0, ...s.days.map((each) => each.usd));
  const kept = s.keepWarm.pings > 0 || s.keepWarm.avoided > 0;
  return <>
    <div className="week-head">
      <button type="button" className="icon-button" aria-label={t("Previous week")} title={t("Previous week")} disabled={previous === null} onClick={onOlder}><ChevronLeft aria-hidden="true" /></button>
      <p className="week-range">{range}</p>
      <button type="button" className="icon-button" aria-label={t("Next week")} title={t("Next week")} disabled={!hasNewer} onClick={onNewer}><ChevronRight aria-hidden="true" /></button>
    </div>
    <section className="session-card week-card" aria-label={t("This week")}>
      <Hero usd={s.total.usd} floor={s.total.floor} />
      <p className="week-delta">{[moved, spread].filter(Boolean).join(" · ")}</p>
      <div className="week-bars" role="img" aria-label={t("Cost per day")}>
        {s.days.map((each) => {
          const rest = each.usd - each.restartsUsd;
          const weekday = utcDate(Date.parse(each.day), locale, { weekday: "narrow" });
          return <div key={each.day} className="week-bar" title={`${utcDate(Date.parse(each.day), locale, { weekday: "short", month: "short", day: "numeric" })} · ${digestUsd(each.usd)}`}>
            <span className="week-bar-track">
              <span className="week-bar-stack" style={{ height: `${top > 0 ? Math.round((each.usd / top) * 1000) / 10 : 0}%` }}>
                {rest > 0.005 && <span className="cost-part is-reads" style={{ flexGrow: rest }} />}
                {each.restartsUsd > 0.005 && <span className="cost-part is-restarts" style={{ flexGrow: each.restartsUsd }} />}
              </span>
            </span>
            <span className="week-bar-day" aria-hidden="true">{weekday}</span>
          </div>;
        })}
      </div>
      <div className="session-cost-pills">
        {(s.restarts.n > 0 || s.restarts.usd >= 0.005) && <span className="session-cost-pill is-restart">
          <span aria-hidden="true">🧊</span> {s.restarts.n > 0
            ? t(s.restarts.n === 1 ? "1 cold restart · {usd}" : "{n} cold restarts · {usd}", { n: s.restarts.n, usd: digestUsd(s.restarts.usd) })
            : t("Cold restarts · {usd}", { usd: digestUsd(s.restarts.usd) })}
        </span>}
        {saved >= 0.005 && <span className="session-cost-pill"><span aria-hidden="true">🔥</span> {t("saved {usd}", { usd: digestUsd(saved) })}</span>}
        {s.handoffs > 0 && <span className="session-cost-pill"><span aria-hidden="true">🤝</span> {t(s.handoffs === 1 ? "1 hand-off" : "{n} hand-offs", { n: s.handoffs })}</span>}
        {s.firstWrites.n > 0 && <span className="session-cost-pill"><span aria-hidden="true">✨</span> {t(s.firstWrites.n === 1 ? "First write · {usd}" : "{n} first writes · {usd}", { n: s.firstWrites.n, usd: digestUsd(s.firstWrites.usd) })}</span>}
      </div>
      {s.offline.map((name) => <p key={`off-${name}`} className="host-context-note week-note">{t("{pc} not counted", { pc: name })}</p>)}
      {s.noCounts.map((name) => <p key={`old-${name}`} className="host-context-note week-note">{t("{pc}: update the bridge to count restarts and hand-offs", { pc: name })}</p>)}
    </section>
    {s.chats.length > 0 && <section className="week-group" aria-labelledby="week-chats">
      <h3 className="session-kicker week-group-head" id="week-chats">{t("Costliest chats")}</h3>
      <ul className="week-chats">
        {s.chats.slice(0, 3).map((chat) => <li key={`${chat.machineId}\t${chat.session}`}>
          <button type="button" className="week-chat" onClick={() => onOpenChat({ machineId: chat.machineId, session: chat.session })}>
            <span className="week-chat-text">
              <span className="week-chat-title">{chat.title || t("Copilot chat")}</span>
              <span className="week-chat-meta">{[nameOf(chat.machineId), chat.restarts > 0 ? t(chat.restarts === 1 ? "1 cold restart" : "{n} cold restarts", { n: chat.restarts }) : null].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="week-chat-usd">{digestUsd(chat.usd)}</span>
          </button>
        </li>)}
      </ul>
    </section>}
    {kept && <section className="week-group week-keep-warm" aria-labelledby="week-keep-warm">
      <h3 className="session-kicker week-group-head" id="week-keep-warm">{t("Keep-warm")}</h3>
      <ul className="session-parts">
        <li className="session-part"><span className="session-part-label">{t("Pings")}</span><span className="session-part-value">{`${s.keepWarm.pings} · ${digestUsd(s.keepWarm.usd)}`}</span></li>
        <li className="session-part"><span className="session-part-label">{t("Restarts avoided")}</span><span className="session-part-value">{`${s.keepWarm.avoided} · ${digestUsd(s.keepWarm.avoidedUsd)}`}</span></li>
        <li className="session-part"><span className="session-part-label">{t("Net saved")}</span><span className="session-part-value session-part-usd">{`${saved < -0.005 ? "−" : ""}${digestUsd(saved)}`}</span></li>
      </ul>
    </section>}
  </>;
}

/**
 * The page where App draws it: open while the digest store says so (a digest's tap, `?digest=`,
 * the Costs sheet's link). A chat tapped in it opens as a look, as an alert's does (App.tsx).
 */
export function WeekDigestHost({ onOpenChat }: { onOpenChat(target: { machineId: string; session: string }): void }) {
  const { digests, open } = useWeekDigest();
  if (!open) return null;
  return <WeekSheet key={open.week ?? ""} digests={digests} week={open.week} onClose={weekDigest.close}
    onOpenChat={(target) => { weekDigest.close(); onOpenChat(target); }} />;
}
