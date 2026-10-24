import { toolKind, type ToolKind } from "./toolGroupSummary.ts";

/**
 * What an MCP call ran, as VS Code names it ("Ran `tool` — server"). The host sends an MCP call's
 * `summary` and `past` as its bare name (live, 2026-10-24: `mcp_tool_call`), and its `tool_id` as
 * `<server>-<name>`. A gateway's proxy tool (`mcp_tool_call`, `call_tool`) carries the real tool in
 * its input (`tool_name` and `arguments`): that is the one named.
 */
export interface McpCall { tool: string; server: string | null; args: unknown }

const PROXIES = new Set(["mcp_tool_call", "call_tool", "mcp_call_tool"]);

export function mcpCall(part: { name: string; tool_id?: string; input: string }): McpCall | null {
  if (toolKind(part as Parameters<typeof toolKind>[0]) !== ("mcp" satisfies ToolKind)) return null;
  const id = part.tool_id ?? part.name;
  const server = id.endsWith(`-${part.name}`) && id.length > part.name.length + 1 ? id.slice(0, -(part.name.length + 1)) : null;
  let input: unknown;
  try { input = JSON.parse(part.input); } catch { return { tool: part.name, server, args: part.input }; }
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const inner = fields !== null && PROXIES.has(part.name) ? fields["tool_name"] ?? fields["name"] : undefined;
  if (typeof inner === "string" && inner.length > 0) return { tool: inner, server, args: fields!["arguments"] ?? {} };
  return { tool: part.name, server, args: input };
}
