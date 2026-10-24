import { describe, expect, it } from "bun:test";

import { mcpCall } from "./mcpCall.ts";

// as the bridge sends them (live, 2026-10-24, chat 591b2f3f)
const proxied = {
  name: "mcp_tool_call", tool_id: "lab-search-mcp_tool_call", summary: "mcp_tool_call", past: "mcp_tool_call",
  input: JSON.stringify({ tool_name: "mobbin-search_screens", arguments: { platform: "ios", query: "FICTIONAL composer", mode: "deep", limit: 6 } }, null, 2),
};
const searched = {
  name: "mcp_tool_search", tool_id: "lab-search-mcp_tool_search", summary: "mcp_tool_search", past: "mcp_tool_search",
  input: JSON.stringify({ query: "FICTIONAL mobbin", top_k: 5 }),
};

describe("mcpCall", () => {
  it("names the tool a gateway's mcp_tool_call ran, its server and its own arguments", () => {
    expect(mcpCall(proxied)).toEqual({ tool: "mobbin-search_screens", server: "lab-search", args: { platform: "ios", query: "FICTIONAL composer", mode: "deep", limit: 6 } });
  });

  it("keeps a direct tool's own name and input", () => {
    expect(mcpCall(searched)).toEqual({ tool: "mcp_tool_search", server: "lab-search", args: { query: "FICTIONAL mobbin", top_k: 5 } });
  });

  it("has no server when the id doesn't end in the name, and reads input that isn't JSON as text", () => {
    expect(mcpCall({ name: "FICTIONAL issue", tool_id: "mcp_github_issue", input: "not json" })).toEqual({ tool: "FICTIONAL issue", server: null, args: "not json" });
  });

  it("is null for a call that is not an MCP tool's", () => {
    expect(mcpCall({ name: "bash", tool_id: "bash", input: "{}" })).toBeNull();
  });
});
