/**
 * A host chat's status line, between its transcript and its composer: what the chat waits on, in
 * VS Code's words (hostStatusLine). Its context meter (contextMeter) opens the window's breakdown as
 * Copilot reports it. It is the composer's on every width, by the round button, as VS Code's input
 * toolbar has it (HostChatView passes it as the composer's toolbarEnd).
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { HostChatRead, HostContextUsage } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { contextMeter, hostStatusLine } from "../lib/hostChats.ts";
import { formatUsd } from "../lib/chatCost.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

/** VS Code's counts in its popup: "136.4K", "1.2M" (chatContextUsageDetails formatTokenCount, one decimal) */
export function formatTokenCount(count: number): string {
  if (count >= 999_950) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

/** the older bridges' three parts, when the host gives no rows of its own (parts), and their category */
const LEGACY_PART = {
  systemTokens: "system",
  toolDefinitionsTokens: "system",
  conversationTokens: "user",
} as const;

/** the words a row or a heading of the popup is drawn with: VS Code's labels, translated */
const CONTEXT_PART = {
  systemTokens: "System prompt",
  toolDefinitionsTokens: "Tool Definitions",
  conversationTokens: "Messages",
  tool: "Tool Results",
  skill: "Skills",
  subagent: "Sub-agents",
  mcpServer: "MCP Tools",
  plugin: "Plugins",
  other: "Other",
  headingSystem: "System",
  headingUser: "User Context",
  headingOther: "Uncategorized",
};

type Row = { category: "system" | "user" | "other"; label: string; percent: number };

/**
 * VS Code's breakdown rows (chatContextUsageDetails renderTokenDetails): each a share of the prompt
 * read as a share of the window, rows under 0.05% left out, and what the rows leave of the prompt
 * as Uncategorized "Other".
 */
export function contextRows(usage: HostContextUsage): Row[] {
  const used = Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
  const parts = usage.parts ?? (Object.keys(LEGACY_PART) as (keyof typeof LEGACY_PART)[]).flatMap((key) => {
    const value = usage[key];
    return value === undefined || usage.currentTokens <= 0 ? [] : [{ category: LEGACY_PART[key], label: CONTEXT_PART[key], share: Math.round((value / usage.currentTokens) * 100) }];
  });
  if (parts.length === 0) return [];
  const total = parts.reduce((sum, part) => sum + part.share, 0);
  const rows: Row[] = [...parts, ...(total < 100 ? [{ category: "other" as const, label: CONTEXT_PART.other, share: 100 - total }] : [])]
    .map((part) => ({ category: part.category, label: part.label, percent: (part.share / 100) * used }));
  return rows.filter((row) => row.percent >= 0.05);
}

const CATEGORY_TITLE = { system: CONTEXT_PART.headingSystem, user: CONTEXT_PART.headingUser, other: CONTEXT_PART.headingOther } as const;

interface MeterProps {
  read: HostChatRead | null; open: boolean; onOpen(): void; onClose(): void;
  /** the chat's cost at list price (OmniRoute's, then LiteLLM's); absent while unknown */
  cost?: { usd: number; partial: boolean; missing: string[]; estimated: string[] } | null;
  /** VS Code's Compact Conversation: sends /compact; absent while the chat works */
  onCompact?: () => void;
  /** the sheet the meter opens instead of the context window's (the Session sheet while costs are tracked, ZAC-260) */
  sheet?: ReactNode;
}

/** `workShown`: the session pills already count the running subagents and shells, so the line does not say it twice */
export function HostChatStatus({ read, workShown = false }: { read: HostChatRead | null; workShown?: boolean }) {
  const t = useT();
  if (read === null) return null;
  const line = hostStatusLine(read, t, { workShown });
  if (line === null) return null;
  return <div className="host-chat-status">
    <span className="host-chat-status-line" role="status">{line}</span>
  </div>;
}

/** The context meter: a ring and the percent; the counts are in its title and its sheet. */
export function HostContextMeter({ read, open, onOpen, onClose, cost, onCompact, sheet }: MeterProps) {
  const t = useT();
  const meter = contextMeter(read?.context ?? null);
  if (read === null || meter === null) return null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const percent = meter.label.split(" · ")[0];
  return <>
    <button type="button" className={`host-chat-meter${meter.percent >= 80 ? " is-high" : ""}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={t("Context window: {usage}", { usage: meter.label })} title={t("Context window: {usage}", { usage: meter.label })} onClick={onOpen}>
      <svg className="host-chat-meter-ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="host-chat-meter-track" cx="8" cy="8" r={radius} />
        <circle className="host-chat-meter-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * meter.percent / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      <span className="host-chat-meter-label" aria-hidden="true">{percent}</span>
    </button>
    {open && (sheet ?? (read.context && <ContextSheet usage={read.context} cost={cost ?? null} onClose={onClose} onCompact={onCompact} />))}
  </>;
}

export function ContextSheet({ usage, cost, onClose, onCompact }: { usage: HostContextUsage; cost: MeterProps["cost"] | null; onClose(): void; onCompact?: (() => void) | undefined }) {
  const t = useT();
  return <SheetFrame label={t("Context window")} title={t("Context window")} onClose={onClose}>
    <ContextPanel usage={usage} cost={cost} onClose={onClose} onCompact={onCompact} />
  </SheetFrame>;
}

/**
 * The context sheet's frame, for it and the Session sheet: the dialog over its scrim, its title and
 * close button, a swipe or Escape or Back closing it; `head` under the header (the Session tabs).
 * Drawn in place where there is no document (a test's server render), in a portal otherwise.
 */
export function SheetFrame({ label, title, className = "", head, onClose, children }: { label: string; title: string; className?: string; head?: ReactNode; onClose(): void; children: ReactNode }) {
  const t = useT();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const sheet = <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className={`modal host-context-sheet${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <header className="modal-header">
        <h2 className="modal-title">{title}</h2>
        <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {head}
      <div className="modal-body host-context-body">{children}</div>
    </div>
  </div>;
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

/** The context sheet's content (VS Code's popup): the cost estimate when given, the window's bar, its breakdown, Compact. */
export function ContextPanel({ usage, cost, onClose, onCompact }: { usage: HostContextUsage; cost: MeterProps["cost"] | null; onClose(): void; onCompact?: (() => void) | undefined }) {
  const t = useT();
  const used = Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
  const reserved = usage.reservedTokens === undefined ? 0 : Math.max(0, Math.min(100 - used, (usage.reservedTokens / usage.tokenLimit) * 100));
  const rows = contextRows(usage);
  const groups = (["system", "user", "other"] as const).map((category) => ({ category, rows: rows.filter((row) => row.category === category) })).filter((group) => group.rows.length > 0);
  const level = used >= 90 ? " is-full" : used >= 75 ? " is-high" : "";
  return <>
    {cost && <section className="host-picker-group" aria-labelledby="host-context-cost">
      <h3 className="host-picker-provider" id="host-context-cost">{t("Session")}</h3>
      <div className="host-picker-rows">
        <div className="host-context-row">
          <span>{t("Cost at list price")}</span>
          <strong className="host-context-cost">{cost.partial || cost.missing.length > 0 ? "≥ " : "~"}{formatUsd(cost.usd)}</strong>
        </div>
      </div>
      <p className="host-context-note">{[
        cost.missing.length > 0 ? t("No price for {models}.", { models: cost.missing.join(", ") }) : null,
        cost.estimated.length > 0 ? t("{models} priced as its base model.", { models: cost.estimated.join(", ") }) : null,
        cost.partial ? t("Older turns are not loaded, or reported no usage: at least this much.") : null,
      ].filter(Boolean).join(" ") || t("Tokens at list prices (OmniRoute, then LiteLLM), subscriptions included.")}</p>
    </section>}
    <section className={`host-context-window${level}`} aria-label={t("Context window")}>
      <div className="host-context-head">
        <span className="host-context-count">{t("{used} / {limit} tokens", { used: formatTokenCount(usage.currentTokens), limit: formatTokenCount(usage.tokenLimit) })}</span>
        <span className="host-context-percent">{Math.round(used)}%</span>
      </div>
      <div className="host-context-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)} aria-label={t("Context window used")}>
        <span className="host-context-used" style={{ width: `${used}%` }} />
        {reserved > 0 && <span className="host-context-reserved" style={{ width: `${reserved}%` }} />}
      </div>
      {reserved > 0 && <p className="host-context-legend"><span className="host-context-swatch" aria-hidden="true" />{t("Reserved for response")}</p>}
    </section>
    {groups.map((group) => (
      <section key={group.category} className="host-picker-group" aria-labelledby={`host-context-${group.category}`}>
        <h3 className="host-picker-provider" id={`host-context-${group.category}`}>{t(CATEGORY_TITLE[group.category])}</h3>
        <dl className="host-picker-rows host-context-parts">
          {group.rows.map((row) => <div key={row.label} className="host-context-row"><dt>{t(row.label)}</dt><dd>{row.percent.toFixed(1)}%</dd></div>)}
        </dl>
      </section>
    ))}
    {onCompact && <button type="button" className="btn host-context-compact" onClick={() => { onCompact(); onClose(); }}>{t("Compact Conversation")}</button>}
  </>;
}
