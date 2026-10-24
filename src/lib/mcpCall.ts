import { toolKind, type ToolKind } from "./toolGroupSummary.ts";

/**
 * What an MCP call ran, as VS Code names it ("Ran `tool` — server"). The host sends an MCP call's
 * `summary` and `past` as its bare name (live, 2026-10-24: `mcp_tool_call`), and its `tool_id` as
 * `<server>-<name>`. A gateway's proxy tool (`mcp_tool_call`, `call_tool`) carries the real tool in
 * its input (`tool_name` and `arguments`): that is the one named.
 */
export interface McpCall { tool: string; server: string | null; args: unknown }

const PROXIES = new Set(["mcp_tool_call", "call_tool", "mcp_call_tool"]);
// a gateway's own tools, by which a full id is cut into server and name when the name is the id
const GATEWAY_TOOLS = [...PROXIES, "mcp_tool_search", "search_tools", "list_tools"];

export function mcpCall(part: { name: string; tool_id?: string; input: string }): McpCall | null {
  if (toolKind(part as Parameters<typeof toolKind>[0]) !== ("mcp" satisfies ToolKind)) return null;
  const id = part.tool_id ?? part.name;
  // the web read may carry the full id as the name too (live, 2026-10-24): a gateway proxy's own
  // name is then the id's end
  const name = part.name === id ? GATEWAY_TOOLS.find((proxy) => id.endsWith(`-${proxy}`)) ?? part.name : part.name;
  const server = id.endsWith(`-${name}`) && id.length > name.length + 1 ? id.slice(0, -(name.length + 1)) : null;
  let input: unknown;
  try { input = JSON.parse(part.input); } catch { return { tool: name, server, args: part.input }; }
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const inner = fields !== null && PROXIES.has(name) ? fields["tool_name"] ?? fields["name"] : undefined;
  if (typeof inner === "string" && inner.length > 0) return { tool: inner, server, args: fields!["arguments"] ?? {} };
  return { tool: name, server, args: input };
}

/**
 * Whether the host's words for an MCP call say more than its name: the host sends the bare name
 * (`mcp_tool_call`), and `"mcp_tool_call" failed` for one that failed; neither is worth showing over
 * "Ran `tool` server" / "Failed `tool` server".
 */
export function mcpWordsSayMore(words: string | undefined, part: { name: string; tool_id?: string }): boolean {
  if (words === undefined) return false;
  const bare = words.trim().replace(/\s+failed$/i, "").replace(/^["'`](.*)["'`]$/, "$1");
  if (bare.length === 0) return false;
  const id = part.tool_id ?? part.name;
  return bare !== part.name && bare !== id && !id.endsWith(`-${bare}`);
}
