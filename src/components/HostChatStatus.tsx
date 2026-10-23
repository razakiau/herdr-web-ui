/**
 * A host chat's status line, between its transcript and its composer: what the chat waits on, in
 * VS Code's words (hostStatusLine). Its context meter (contextMeter) opens the window's breakdown as
 * Copilot reports it. With room it is the composer's, by Send, as VS Code's input toolbar has it; a
 * phone's toolbar has none to spare (the model's name was cut), so there it ends this line instead.
 * Both are drawn and CSS shows one (HostChatView.css, .host-chat-meter[data-place]).
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { HostChatRead, HostContextUsage } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import { contextMeter, hostStatusLine } from "../lib/hostChats.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

const formatTokens = (value: number): string => value.toLocaleString();

/** the parts Copilot breaks the window into, when it does */
const CONTEXT_PART = {
  conversationTokens: "Conversation",
  systemTokens: "System",
  toolDefinitionsTokens: "Tool definitions",
};

interface MeterProps { read: HostChatRead | null; open: boolean; onOpen(): void; onClose(): void }

/** `workShown`: the session pills already count the running subagents and shells, so the line does not say it twice */
export function HostChatStatus({ workShown = false, ...meter }: MeterProps & { workShown?: boolean }) {
  const t = useT();
  const { read } = meter;
  if (read === null) return null;
  const line = hostStatusLine(read, t, { workShown });
  const hasMeter = contextMeter(read.context ?? null) !== null;
  if (line === null && !hasMeter) return null;
  return <div className={`host-chat-status${line === null ? " is-meter-only" : ""}`}>
    <span className="host-chat-status-line" role="status">{line}</span>
    <HostContextMeter {...meter} place="status" />
  </div>;
}

/** The context meter: a ring and the percent; the counts are in its title and its sheet. */
export function HostContextMeter({ read, open, onOpen, onClose, place = "toolbar" }: MeterProps & { place?: "toolbar" | "status" }) {
  const t = useT();
  const meter = contextMeter(read?.context ?? null);
  if (read === null || meter === null) return null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const percent = meter.label.split(" · ")[0];
  return <>
    <button type="button" className={`host-chat-meter${meter.percent >= 80 ? " is-high" : ""}`} data-place={place} aria-haspopup="dialog" aria-expanded={open}
      aria-label={t("Context window: {usage}", { usage: meter.label })} title={t("Context window: {usage}", { usage: meter.label })} onClick={onOpen}>
      <svg className="host-chat-meter-ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="host-chat-meter-track" cx="8" cy="8" r={radius} />
        <circle className="host-chat-meter-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * meter.percent / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      <span className="host-chat-meter-label" aria-hidden="true">{percent}</span>
    </button>
    {open && place === "toolbar" && read.context && <ContextSheet usage={read.context} label={meter.label} onClose={onClose} />}
  </>;
}

function ContextSheet({ usage, label, onClose }: { usage: HostContextUsage; label: string; onClose(): void }) {
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
  // what the host breaks the window into, when it does
  const parts = (Object.keys(CONTEXT_PART) as (keyof typeof CONTEXT_PART)[])
    .flatMap((key) => (usage[key] === undefined ? [] : [{ name: CONTEXT_PART[key], value: usage[key] }]));
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal host-context-sheet" role="dialog" aria-modal="true" aria-label={t("Context window")} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title">{t("Context window")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <p className="host-context-total">{label}</p>
          <dl className="host-context-parts">
            {parts.map((part) => <div key={part.name}><dt>{t(part.name)}</dt><dd>{formatTokens(part.value)}</dd></div>)}
            <div className="is-total"><dt>{t("Used")}</dt><dd>{t("{used} of {limit}", { used: formatTokens(usage.currentTokens), limit: formatTokens(usage.tokenLimit) })}</dd></div>
          </dl>
        </div>
      </div>
    </div>,
    document.body,
  );
}
