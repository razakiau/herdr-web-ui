/**
 * Chat groups (ZAC-265 PR 2), a group's digest card on its page, above "Chats" (spec §4 E.2): a
 * header line naming what wrote it ("Digest · Haiku 5.5 low · $0.004 · 2 h ago", then Refresh), the
 * Direction, and a facts line ("3 issues open · 2 PRs in review") with the PR and issue glyphs in
 * their live state's colours. A tap opens the rest: Still open, Done (each item with its chat's
 * artifact, a tap opening it; an item with none is an unfinished thread, and no link), and Per chat
 * (one line each, newest first, each opening its chat; past 20 chats a line per week, each opened
 * on its own). On top, when chats moved on since it was written, says how many, with Refresh.
 * Writing shows its progress and dims the digest it replaces; a failure keeps the old one with the
 * error under its header. With no digest, the card says so and offers to write one, with its cost.
 */
import { useId, useState } from "react";
import { ChevronDown, CircleDashed, CircleDot, GitPullRequest, History, LoaderCircle, TriangleAlert } from "lucide-react";

import "./DigestCard.css";

import type { DigestEstimate, DigestFailure, DigestProgress, GroupDigest } from "../../shared/groups.ts";
import type { HostArtifact } from "../../shared/host-chats.ts";
import { shortLabel, type ReferenceState } from "../lib/artifacts.ts";
import { digestFacts, digestUsd, perChatWeeks, type PerChatLine } from "../lib/digest.ts";
import { ageWords } from "../lib/hostChats.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { modelLabel } from "../lib/modelName.ts";
import { ArtifactGlyph } from "./HostSessionPills.tsx";
import { shortDate } from "./GroupsSheet.tsx";

export interface DigestCardProps {
  /** the group's digest; null before the first */
  digest: GroupDigest | null;
  /** chats that moved on since it (lib/digest.ts staleCount) */
  stale: number;
  /** a refresh under way, or null */
  progress?: DigestProgress | null;
  /** the last refresh's failure, or null */
  failure?: DigestFailure | null;
  /** with no digest: the group's chats and its first day, and what a first digest would cost */
  chats: number;
  since: number;
  estimate?: DigestEstimate | null;
  /** Per chat, the digest's lines with the chat's short name and when it last changed */
  perChat: readonly (PerChatLine & { name: string })[];
  /** the PR and issue states, as the chat's pills read them */
  states: Readonly<Record<string, ReferenceState>>;
  now: number;
  /** open at first (the harness's shots) */
  expanded?: boolean;
  onRefresh(): void;
  onOpenChat(target: { pc: string; session: string }): void;
  onOpenArtifact(artifact: HostArtifact): void;
}

/**
 * A model as a person names it: lib/modelName.ts's rule, and for a router's route to a vendor's id
 * (OmniRoute's `opencode-go-claude-haiku-5-5`) the vendor's id inside it, when that reads whole.
 * The id stays in the title either way.
 */
export function digestModelName(id: string): string {
  const own = modelLabel(id);
  if (own.named) return own.text;
  const parts = id.split("-");
  for (let at = 1; at < parts.length; at++) {
    const inner = modelLabel(parts.slice(at).join("-"));
    if (inner.named) return inner.text;
  }
  return id;
}

const effortWord = (effort: GroupDigest["effort"], t: Translate): string => effort === "high" ? t("high") : effort === "medium" ? t("medium") : t("low");

export function DigestCard({ digest, stale, progress = null, failure = null, chats, since, estimate = null, perChat, states, now, expanded = false, onRefresh, onOpenChat, onOpenArtifact }: DigestCardProps) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(expanded);
  const [weeksOpen, setWeeksOpen] = useState<ReadonlySet<number>>(new Set());
  const writing = progress !== null;
  const progressLine = progress === null ? null
    : progress.stage === "summaries" ? t("Summarising {done} of {total} chats…", { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : t("Writing the group digest…");
  const chatsWord = t(chats === 1 ? "1 chat" : "{n} chats", { n: chats });

  if (digest === null) {
    return <section className="digest-card is-empty" aria-label={t("Digest")}>
      {writing
        ? <p className="digest-progress" role="status"><LoaderCircle className="digest-spin" aria-hidden="true" />{progressLine}</p>
        : <>
          <p className="digest-empty">{t("No digest yet. {chats} since {date}.", { chats: chatsWord, date: shortDate(since, locale) })}</p>
          {failure && <p className="digest-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{`${failure.source}: ${failure.message}`}</span></p>}
          <button type="button" className="btn digest-write" onClick={onRefresh}>
            {estimate ? t("Write digest ({usd})", { usd: `≈ ${digestUsd(estimate.usd)}` }) : t("Write digest")}
          </button>
        </>}
    </section>;
  }

  const written = Date.parse(digest.writtenAt);
  const age = ageWords(written, now, t);
  const facts = digestFacts(digest, states);
  const weeks = perChatWeeks(perChat);
  const stateOf = (artifact: HostArtifact): ReferenceState | undefined => artifact.link ? states[artifact.link] : undefined;
  const items = (list: GroupDigest["open"]) => <ul className="digest-items">{list.map((item, index) => {
    const artifact = item.artifact;
    return <li key={index} className="digest-item">
      {artifact
        ? <button type="button" className="digest-item-row" onClick={() => onOpenArtifact(artifact)}>
          <ArtifactGlyph artifact={artifact} state={stateOf(artifact)} />
          <span className="digest-item-text">{item.text}</span>
          <span className="digest-item-ref">{shortLabel(artifact)}</span>
        </button>
        // no artifact, no link: an unfinished thread, said as words only
        : <div className="digest-item-row is-static">
          <CircleDashed className="session-pill-icon" aria-hidden="true" />
          <span className="digest-item-text">{item.text}</span>
        </div>}
    </li>;
  })}</ul>;
  const chatLine = (line: PerChatLine & { name: string }) => <li key={`${line.pc} ${line.session}`}>
    <button type="button" className="digest-chat" onClick={() => onOpenChat({ pc: line.pc, session: line.session })}>
      <span className="digest-chat-name">{line.name}</span>
      <span className="digest-chat-line">{line.line}</span>
    </button>
  </li>;

  return <section className={`digest-card${writing ? " is-writing" : ""}`} aria-label={t("Digest")}>
    {stale > 0 && !writing && failure === null && <div className="digest-stale">
      <History aria-hidden="true" />
      <span>{t(stale === 1 ? "1 chat moved on since this digest" : "{n} chats moved on since this digest", { n: stale })}</span>
      <button type="button" className="digest-link" onClick={onRefresh}>{t("Refresh")}</button>
    </div>}
    <header className="digest-head">
      <span className="digest-head-text">
        <strong>{t("Digest")}</strong>
        <span aria-hidden="true">·</span>
        <span title={digest.model}>{digestModelName(digest.model)} {effortWord(digest.effort, t)}</span>
        <span aria-hidden="true">·</span>
        <span>{digestUsd(digest.costUsd)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={digest.writtenAt}>{age}</time>
      </span>
      {/* one Refresh: the stale notice's, when it shows */}
      {!writing && (failure !== null || stale === 0) && <button type="button" className="digest-link" onClick={onRefresh}>{failure ? t("Try again") : t("Refresh")}</button>}
    </header>
    {failure && !writing && <p className="digest-error" role="alert"><TriangleAlert aria-hidden="true" />
      <span>{t("{source}: {message} · kept the digest from {age}", { source: failure.source, message: failure.message, age })}</span></p>}
    {writing && <p className="digest-progress" role="status"><LoaderCircle className="digest-spin" aria-hidden="true" />{progressLine}</p>}
    <button type="button" className="digest-body" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen(!open)}>
      <span className="digest-direction">{digest.direction}</span>
      <span className="digest-facts">
        {facts.issues > 0 && <span className="digest-fact"><CircleDot className="session-pill-icon" data-tone="green" aria-hidden="true" />{t(facts.issues === 1 ? "1 issue open" : "{n} issues open", { n: facts.issues })}</span>}
        {facts.prs > 0 && <span className="digest-fact"><GitPullRequest className="session-pill-icon" data-tone="green" aria-hidden="true" />{t(facts.prs === 1 ? "1 PR in review" : "{n} PRs in review", { n: facts.prs })}</span>}
        {facts.issues === 0 && facts.prs === 0 && <span className="digest-fact">{t("Nothing open")}</span>}
        <ChevronDown className="digest-caret" aria-hidden="true" />
      </span>
    </button>
    {open && <div className="digest-more" id={`${id}-more`}>
      {digest.open.length > 0 && <section className="digest-part" aria-labelledby={`${id}-open`}>
        <h4 className="digest-part-head" id={`${id}-open`}>{t("Still open")}</h4>
        {items(digest.open)}
      </section>}
      {digest.done.length > 0 && <section className="digest-part" aria-labelledby={`${id}-done`}>
        <h4 className="digest-part-head" id={`${id}-done`}>{t("Done")}</h4>
        {items(digest.done)}
      </section>}
      {perChat.length > 0 && <section className="digest-part" aria-labelledby={`${id}-chats`}>
        <h4 className="digest-part-head" id={`${id}-chats`}>{t("Per chat")}</h4>
        {weeks === null
          ? <ul className="digest-chats">{perChat.map(chatLine)}</ul>
          : <ul className="digest-chats">{weeks.map((week) => {
            const on = weeksOpen.has(week.start);
            return <li key={week.start} className="digest-week">
              <button type="button" className="digest-chat digest-week-head" aria-expanded={on}
                onClick={() => setWeeksOpen((last) => { const next = new Set(last); if (on) next.delete(week.start); else next.add(week.start); return next; })}>
                <span className="digest-chat-name">{t("Week of {date}", { date: shortDate(week.start, locale) })}</span>
                <span className="digest-chat-line">{t(week.lines.length === 1 ? "1 chat" : "{n} chats", { n: week.lines.length })}</span>
                <ChevronDown className="digest-caret" aria-hidden="true" />
              </button>
              {on && <ul className="digest-chats is-nested">{week.lines.map(chatLine)}</ul>}
            </li>;
          })}</ul>}
      </section>}
    </div>}
  </section>;
}
