/**
 * The "+" dialog's agent host choice (NewSessionDialog, kind `copilot-host`): VS Code's New Chat.
 * The dialog asks only for the folder; Start makes the chat there with no message
 * (openEmptyHostChat) and opens it, so the first message is written in the chat's own composer,
 * with its model, agent, mode and permission pills, "/" skills, "@" files, attachments, dictation
 * and send menu: one composer everywhere. A chat left without a message goes (HostChatView).
 */
import { forwardRef, useImperativeHandle, useRef } from "react";

import { useT } from "../lib/i18n.ts";
import { applyNewChatDefaults, attemptFor, openEmptyHostChat, sendErrorText } from "../lib/hostChats.ts";
import { useSettings } from "../lib/settings.ts";

export interface NewHostChatHandle {
  /** makes the chat in `cwd`: its session, or a reason it was not made */
  start(cwd: string): Promise<{ session: string } | { error: string }>;
  ready(): boolean;
}

export const NewHostChatFields = forwardRef<NewHostChatHandle, { machineId: string }>(
  function NewHostChatFields({ machineId }, ref) {
    const t = useT();
    const { settings } = useSettings();
    // the id this chat goes under: kept while the same folder is tried again after a failure (the
    // bridge then makes the chat once), new when the folder changes
    const attempt = useRef<{ key: string; id: string } | null>(null);
    useImperativeHandle(ref, () => ({
      ready: () => true,
      async start(folder) {
        attempt.current = attemptFor(attempt.current, JSON.stringify([machineId, folder]));
        try {
          const session = await openEmptyHostChat(machineId, { id: attempt.current.id, cwd: folder });
          // Settings' new chat defaults (Agent host), before the chat opens: its pills show them
          await applyNewChatDefaults(machineId, session, { model: settings.hostNewModel, approvals: settings.hostNewApprovals });
          return { session };
        } catch (cause) {
          return { error: sendErrorText(cause, t, true) };
        }
      },
    }), [machineId, t, settings.hostNewModel, settings.hostNewApprovals]);
    return <p className="field-hint new-host-chat-hint">{t("The chat opens in this folder: write your first message there.")}</p>;
  },
);
