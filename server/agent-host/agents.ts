/**
 * The "+" dialog's agent host choice: `/api/agents` lists `copilot-host` for a PC whose agent host
 * is connected and signed in, so a chat can start there as any other agent does. It is named for
 * its source, "Agent host"; where the `copilot` command is installed too, that pane kind reads
 * "Copilot (terminal)", so the two Copilots stay told apart.
 */
import type { AgentHostState } from "../../shared/host-chats.ts";
import type { AgentKind } from "../../shared/protocol.ts";
import { HOST_AGENT_KIND } from "../../shared/supported-agents.ts";

export function withHostAgent(agents: readonly AgentKind[], host: AgentHostState | null): AgentKind[] {
  if (host?.state !== "connected" || !host.signed_in) return [...agents];
  const pane = agents.some((agent) => agent.kind === "copilot" && agent.installed !== false);
  return [
    ...agents.map((agent) => (pane && agent.kind === "copilot" ? { ...agent, label: "Copilot (terminal)" } : agent)),
    { kind: HOST_AGENT_KIND, label: "Agent host", installed: true },
  ];
}
