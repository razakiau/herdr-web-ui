import type { HostCommand } from "../../shared/host-chats.ts";
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
 * The text a Hand off click sends, or null when the session does not list a `handoff` command
 * among its "/" commands (HostChatRead.commands, the handoff skill): drawn only where it can work,
 * as Compact is (ZAC-260).
 */
export function handoffCommandText(commands: readonly HostCommand[]): string | null {
  return commands.some((command) => command.name === "handoff") ? "/handoff" : null;
}
