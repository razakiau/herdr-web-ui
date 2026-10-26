import { describe, expect, it } from "bun:test";
import { facetCounts, inFacet } from "./agentFacets.ts";

describe("the Agents facets (owner, ZAC-233)", () => {
  const statuses = ["blocked", "working", "working", "done", "idle", undefined] as const;

  it("counts every row under All and each status under its own facet", () => {
    expect(facetCounts(statuses)).toEqual({ all: 6, blocked: 1, working: 2, done: 1 });
  });

  it("keeps every row under All", () => {
    expect(statuses.filter((status) => inFacet("all", status))).toHaveLength(6);
  });

  it("keeps only the facet's own rows under a status facet", () => {
    expect(statuses.filter((status) => inFacet("blocked", status))).toEqual(["blocked"]);
    expect(statuses.filter((status) => inFacet("working", status))).toEqual(["working", "working"]);
    expect(statuses.filter((status) => inFacet("done", status))).toEqual(["done"]);
  });
});
