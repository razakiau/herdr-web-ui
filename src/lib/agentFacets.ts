// The Agents lens's facets (owner, ZAC-233, 2026-10-26): All | Needs you | Working | Done, one at a
// time, each with its count. They replace the head's marks and its ⋯; a pick lasts for the page.
import type { AgentStatus } from "../../shared/protocol.ts";

export type AgentFacet = "all" | "blocked" | "working" | "done";
export const AGENT_FACETS: readonly AgentFacet[] = ["all", "blocked", "working", "done"];

/** How many rows each facet keeps. */
export function facetCounts(statuses: readonly (AgentStatus | undefined)[]): Record<AgentFacet, number> {
  const counts: Record<AgentFacet, number> = { all: statuses.length, blocked: 0, working: 0, done: 0 };
  for (const status of statuses) if (status === "blocked" || status === "working" || status === "done") counts[status as AgentFacet]++;
  return counts;
}

/** Whether a row of this status stays under the facet. */
export const inFacet = (facet: AgentFacet, status: AgentStatus | undefined): boolean => facet === "all" || status === facet;
