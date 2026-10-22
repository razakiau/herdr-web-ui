/**
 * A host chat's status row, between its transcript and its composer: what the chat waits on, in
 * VS Code's words (hostStatusLine), and its context meter (contextMeter) at the end. The meter
 * opens the window's breakdown as Copilot reports it. Nothing is drawn when there is neither.
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

export function HostChatStatus({ read, open, onOpen, onClose }: { read: HostChatRead | null; open: boolean; onOpen(): void; onClose(): void }) {
  const t = useT();
  if (read === null) return null;
  const line = hostStatusLine(read, t);
  const meter = contextMeter(read.context ?? null);
  if (line === null && meter === null) return null;
  return <div className="host-chat-status">
    <span className="host-chat-status-line" role="status">{line}</span>
    {meter && <button type="button" className={`host-chat-meter${meter.percent >= 80 ? " is-high" : ""}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={t("Context window: {usage}", { usage: meter.label })} title={t("Context window: {usage}", { usage: meter.label })} onClick={onOpen}>
      <span className="host-chat-meter-bar" aria-hidden="true"><span style={{ inlineSize: `${meter.percent}%` }} /></span>
      <span className="host-chat-meter-label">{meter.label}</span>
      {/* a narrow screen keeps the percent; the counts are in the title and the sheet */}
      <span className="host-chat-meter-short" aria-hidden="true">{meter.label.split(" · ")[0]}</span>
    </button>}
    {open && read.context && <ContextSheet usage={read.context} label={meter?.label ?? ""} onClose={onClose} />}
  </div>;
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
