import { describe, expect, it } from "bun:test";

import type { AgentKind } from "../../shared/protocol.ts";
import { withHostAgent } from "./agents.ts";

const claude: AgentKind = { kind: "claude", label: "Claude Code", installed: true };
const copilot: AgentKind = { kind: "copilot", label: "GitHub Copilot", installed: true };

describe("the + dialog's agent host choice", () => {
  it("agents_lists_copilot_host_when_signed_in", () => {
    expect(withHostAgent([claude], { state: "connected", signed_in: true, protocol: "1.0.0" })).toEqual([claude, { kind: "copilot-host", label: "Agent host", installed: true }]);
  });

  it("not listed when the host is off, down, refused or not signed in, and the list is as before", () => {
    for (const host of [null, { state: "off" }, { state: "no_server" }, { state: "starting" }, { state: "refused", server_version: null }, { state: "connected", signed_in: false, protocol: "1.0.0" }] as const) {
      expect({ host, agents: withHostAgent([claude, copilot], host) }).toEqual({ host, agents: [claude, copilot] });
    }
  });

  it("labels_split_when_both: the host is Agent host, the pane kind Copilot (terminal)", () => {
    const listed = withHostAgent([claude, copilot], { state: "connected", signed_in: true, protocol: "1.0.0" });
    expect(listed.map((agent) => [agent.kind, agent.label])).toEqual([["claude", "Claude Code"], ["copilot", "Copilot (terminal)"], ["copilot-host", "Agent host"]]);
    // a copilot command that is not installed is no pane choice, and the pane kind keeps its own name
    expect(withHostAgent([claude, { ...copilot, installed: false }], { state: "connected", signed_in: true, protocol: "1.0.0" }).map((agent) => agent.label)).toEqual(["Claude Code", "GitHub Copilot", "Agent host"]);
  });
});
