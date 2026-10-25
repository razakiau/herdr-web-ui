/**
 * The agent kinds this app offers to start, where they are installed: the ones docs/guide.md lists
 * under Supported agents. herdr's manifests name more; any of those still runs from a pane's shell.
 *
 * Its own file: the browser imports the value, and shared/protocol.ts reads `process.env` as it loads.
 */
export const SUPPORTED_AGENT_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "omp", "omo", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "letta", "copilot-host"]);

/** A Copilot chat on the PC's agent host, offered by "+" where that host is up (server/agent-host/agents.ts). */
export const HOST_AGENT_KIND = "copilot-host";
