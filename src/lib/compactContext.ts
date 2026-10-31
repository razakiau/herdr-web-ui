import { handoffCommand } from "../../shared/handoff-command.ts";
import type { HostChatRead, HostCommand } from "../../shared/host-chats.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/**
 * The text a Compact click sends, or null when the pane's agent does not list a `/compact`
 * command (its `/api/pane/commands` answer): the control is drawn only where it can work.
 */
export function compactCommandText(commands: readonly SlashCommand[]): string | null {
  const found = commands.some((command) => command.name === "compact" && (command.trigger ?? "/") === "/");
  return found ? "/compact" : null;
}

/**
 * The text a Hand off click sends, or null when the session does not list the hand-off skill
 * among its "/" commands (HostChatRead.commands): `/handoff`, or `/harness:handoff` where only the
 * plugin's namespaced name is listed (handoffCommand). Drawn only where it can work, as Compact is (ZAC-260).
 */
export function handoffCommandText(commands: readonly HostCommand[]): string | null {
  return handoffCommand(commands)?.handoff ?? null;
}

/**
 * Whether Hand off & continue can go now (ZAC-262): "ready" while the chat is idle or waits on its
 * own question that takes a typed answer (the bridge answers it with the hand-off words);
 * "working" while it works without asking, or asks for an approval or a closed choice (the bridge
 * would answer busy: the button shows, disabled); null without the hand-off skill.
 */
export function handoffOffer(chat: Pick<HostChatRead, "busy" | "commands"> & { prompt: Pick<NonNullable<HostChatRead["prompt"]>, "kind" | "custom_option_index" | "host"> | null }): "ready" | "working" | null {
  if (handoffCommandText(chat.commands) === null) return null;
  if (!chat.busy) return "ready";
  const prompt = chat.prompt;
  return prompt?.kind === "question" && "request_id" in prompt.host && prompt.custom_option_index !== null ? "ready" : "working";
}
