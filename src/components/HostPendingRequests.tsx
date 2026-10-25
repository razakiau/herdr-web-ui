import { useState } from "react";
import { CornerDownLeft, Pencil, X } from "lucide-react";

import type { HostChatRead } from "../../shared/host-chats.ts";
import { useT } from "../lib/i18n.ts";
import "./HostPendingRequests.css";

type Pending = HostChatRead["pending"][number];

/**
 * A host chat's messages waiting for its running turn, drawn as VS Code draws them (chatListRenderer
 * pending-request): at the end of the transcript, under a "Steering" or "Queued" divider, as greyed
 * requests that become real ones when their turn comes. Send now does VS Code's Send Immediately
 * (the turn stops, the message starts the next); Edit takes it back into the box; Remove drops it.
 */
export function HostPendingRequests({ pending, onSendNow, onEdit, onRemove }: {
  pending: readonly Pending[];
  onSendNow: (id: string) => Promise<string | null>;
  onEdit: (row: Pending) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);
  if (pending.length === 0) return null;
  const groups = (["steering", "queued"] as const).map((kind) => ({ kind, rows: pending.filter((each) => each.kind === kind) })).filter((group) => group.rows.length > 0);
  return <div className="pending-requests" role="group" aria-label={t("Waiting messages")}>
    {groups.map((group) => <section key={group.kind} className="pending-requests-group" data-kind={group.kind}>
      <p className="pending-requests-divider" title={t(group.kind === "steering" ? "Sent after the next tool call" : "Sent after the current request completes")}>
        {t(group.kind === "steering" ? "Steering" : "Queued")}
      </p>
      {group.rows.map((row) => <article key={row.id} className="pending-request" data-pending={row.id} aria-busy={busy === row.id || undefined}>
        <div className="pending-request-bubble">{row.text}</div>
        <div className="pending-request-actions">
          <button type="button" className="chat-meta-btn pending-request-send" disabled={busy !== null} title={t("Send now")} aria-label={`${t("Send now")}: ${row.text.slice(0, 80)}`}
            onClick={() => {
              setBusy(row.id); setFailed(null);
              void onSendNow(row.id).then((error) => { if (error !== null) setFailed({ id: row.id, text: error }); }).finally(() => setBusy(null));
            }}><CornerDownLeft aria-hidden="true" /><span>{t("Send now")}</span></button>
          <button type="button" className="chat-meta-btn" disabled={busy !== null} title={t("Edit")} aria-label={`${t("Edit")}: ${row.text.slice(0, 80)}`} onClick={() => onEdit(row)}><Pencil aria-hidden="true" /></button>
          <button type="button" className="chat-meta-btn" disabled={busy !== null} title={t("Remove from Queue")} aria-label={`${t("Remove from Queue")}: ${row.text.slice(0, 80)}`} onClick={() => onRemove(row.id)}><X aria-hidden="true" /></button>
        </div>
        {failed?.id === row.id && <p className="pending-request-error" role="alert">{failed.text}</p>}
      </article>)}
    </section>)}
  </div>;
}
