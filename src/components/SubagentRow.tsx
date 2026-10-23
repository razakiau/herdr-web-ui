/**
 * A subagent a Copilot turn started, as VS Code draws it (chatSubagentOpenChat.ts at 6d62b1d): its
 * own row, never folded into the turn's tool group. The comment-discussion icon (a spinner while it
 * runs), the agent's name, its task, its model when not the chat's (the bridge says which), and on
 * the right "Working for 3s" / "Worked for 5m 43s". While it runs, a connector line and what it does
 * now. Opened, it reads the subagent's own chat (`readChat`) and draws its turns with the same Turn.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleX, LoaderCircle, MessagesSquare } from "lucide-react";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { useT, type Translate } from "../lib/i18n.ts";

export type SubagentPart = Extract<ConversationPart, { kind: "subagent" }>;

/** VS Code's formatElapsedTime: "{0}s" under a minute, else "{0}m {1}s". */
export function formatElapsedTime(ms: number, t?: Translate): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return t ? t("{s}s", { s: total }) : `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return t ? t("{m}m {s}s", { m: minutes, s: seconds }) : `${minutes}m ${seconds}s`;
}

/** The time it worked, or has worked so far; null when the bridge knows no start. */
function elapsed(part: SubagentPart, now: number): number | null {
  const start = part.started === null ? Number.NaN : Date.parse(part.started);
  if (!Number.isFinite(start)) return null;
  const end = part.ended === null ? (part.status === "running" ? now : Number.NaN) : Date.parse(part.ended);
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** A clock that ticks once a second while `on`: the running row's time counts up. */
function useSecondClock(on: boolean, start: number | undefined): number {
  const [now, setNow] = useState(() => start ?? Date.now());
  useEffect(() => {
    if (!on || start !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on, start]);
  return start ?? now;
}

export interface SubagentRowProps {
  part: SubagentPart;
  /** its turn is the one running */
  live: boolean;
  /** reads the subagent's own chat (lib/chatSource.ts hostSource on its chat URI); without one the row does not open */
  readChat?: (ref: string) => Promise<ConversationTurn[]>;
  /** draws one of its turns (ChatView's Turn) */
  renderTurn?: (turn: ConversationTurn, index: number) => ReactNode;
  /** tests: the clock's "now" */
  now?: number;
}

/** The subagent the reader was just taken to (a host chat's "N running" sheet), by its chat: its row opens and is marked. */
/** A subagent to reveal: by its tool call (the row's id) or its chat; `at` makes each tap a new reveal. */
export interface SubagentTarget { chat?: string; toolCall?: string }
export const RevealedSubagentContext = createContext<(SubagentTarget & { at: number }) | null>(null);
/** Whether a transcript subagent part is the target: the host names a running subagent's work chat apart from the row's resource, the tool call is what both share. */
export function isSubagentTarget(part: { id: string; chat: string | null }, target: SubagentTarget): boolean {
  return (target.toolCall !== undefined && part.id === target.toolCall) || (target.chat !== undefined && part.chat === target.chat);
}

export function SubagentRow({ part, live, readChat, renderTurn, now: fixedNow }: SubagentRowProps) {
  const t = useT();
  // a background subagent runs on after its turn: its own chat is what says it runs
  const running = part.status === "running" && (live || part.background === true);
  const now = useSecondClock(running, fixedNow);
  const [chosen, setOpen] = useChatRowToggle(`subagent:${part.id}`, false);
  const open = chosen === true;
  const revealed = useContext(RevealedSubagentContext);
  const isRevealed = revealed !== null && isSubagentTarget(part, revealed);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isRevealed) return;
    setOpen(true);
    sectionRef.current?.scrollIntoView({ block: "start" });
    // setOpen changes with the row's memory, not with each reveal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevealed, revealed?.at]);
  const canOpen = readChat !== undefined && part.chat !== null;
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || !canOpen) return;
    let current = true;
    setFailed(false);
    readChat!(part.chat!).then((read) => { if (current) setTurns(read); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
    // a running subagent's chat is read again as its row changes (its activity, its end)
  }, [open, canOpen, readChat, part.chat, part.status, part.activity, part.ended, attempt]);

  const ms = elapsed(part, now);
  const duration = ms === null ? null : formatElapsedTime(ms, t);
  const time = duration === null ? null : running ? t("Working for {duration}", { duration }) : t("Worked for {duration}", { duration });
  const Icon = running ? LoaderCircle : part.status === "failed" ? CircleX : MessagesSquare;
  const head = <>
    <Icon className={`subagent-row-icon${running ? " is-spinning" : ""}`} aria-hidden="true" />
    <span className="subagent-row-main">
      <span className="subagent-row-name">{part.agent}</span>
      {part.description.length > 0 && <span className="subagent-row-description" title={part.description}>{part.description}</span>}
      {part.model !== null && <span className="subagent-row-model">{part.model}</span>}
    </span>
    {time !== null && <span className="subagent-row-time">{time}</span>}
    {canOpen && <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>}
  </>;
  return <section ref={sectionRef} className={`subagent-row is-${running ? "running" : part.status === "running" ? "done" : part.status}${isRevealed ? " is-revealed" : ""}`} {...(part.chat !== null ? { "data-subagent-chat": part.chat } : {})} aria-label={t("Subagent: {name}", { name: part.agent })}>
    {canOpen
      ? <button type="button" className="subagent-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>{head}</button>
      : <div className="subagent-row-head">{head}</div>}
    {running && part.activity !== undefined && !open && <p className="subagent-row-activity">{part.activity}</p>}
    {open && canOpen && <div className="subagent-row-body">
      {/* the row's head cuts its words to one line: opened, they stand whole, the agent's own blurb under them */}
      {(part.description.length > 0 || part.about !== undefined) && <div className="subagent-row-about">
        {part.description.length > 0 && <p className="subagent-row-intent">{part.description}</p>}
        {part.about !== undefined && <p className="subagent-row-blurb">{part.about}</p>}
      </div>}
      {failed ? <p className="subagent-row-note">{t("Couldn't load the subagent's chat.")} <button type="button" className="btn btn-ghost" onClick={() => setAttempt((n) => n + 1)}>{t("Retry")}</button></p>
        : turns === null ? <p className="subagent-row-note">{t("Loading…")}</p>
          : turns.length === 0 ? <p className="subagent-row-note">{t("Subagent chat is not available yet.")}</p>
            : turns.map((turn, index) => <div key={index} className="subagent-row-turn">{renderTurn ? renderTurn(turn, index) : null}</div>)}
    </div>}
  </section>;
}
