import { describe, expect, it } from "bun:test";
import { artifactsOf, workOf } from "./artifacts.ts";

const AT = "2026-10-22T10:00:00.000Z";
const meta = (list: unknown) => ({ "agentHost/sessionArtifacts": list });

describe("artifactsOf (VS Code's agentHost/sessionArtifacts, validated as its cas does)", () => {
  it("keeps valid entries newest first, isArtifact defaulting to true, and only the fields VS Code reads", () => {
    const list = [
      { id: "a1", type: "file", label: "FICTIONAL spec", uri: "file:///tmp/fictional/spec.md", extra: "dropped" },
      { id: "a2", type: "pullRequest", label: "FICTIONAL #1", link: "https://github.com/fictional/repo/pull/1", isGitHub: true, isArtifact: true },
      { id: "a3", type: "website", label: "FICTIONAL docs", link: "https://example.invalid/docs", isArtifact: false },
      { id: "a4", type: "commit", label: "FICTIONAL fix", commitHash: "abc1234", chat: "ahp-chat://default/x" },
    ];
    expect(artifactsOf(meta(list))).toEqual([
      { id: "a4", type: "commit", label: "FICTIONAL fix", isArtifact: true, commitHash: "abc1234" },
      { id: "a3", type: "website", label: "FICTIONAL docs", isArtifact: false, link: "https://example.invalid/docs" },
      { id: "a2", type: "pullRequest", label: "FICTIONAL #1", isArtifact: true, link: "https://github.com/fictional/repo/pull/1", isGitHub: true },
      { id: "a1", type: "file", label: "FICTIONAL spec", isArtifact: true, uri: "file:///tmp/fictional/spec.md" },
    ]);
  });

  it("drops what VS Code drops: no id or label, an unknown type, a non-boolean isArtifact; a non-list is none", () => {
    const list = [
      { type: "file", label: "x" }, { id: "b", type: "file" }, { id: "c", type: "folder", label: "x" },
      { id: "d", type: "issue", label: "x", isArtifact: "yes" }, null, "x", [1],
      { id: "e", type: "issue", label: "FICTIONAL ok", link: 7 },
    ];
    expect(artifactsOf(meta(list))).toEqual([{ id: "e", type: "issue", label: "FICTIONAL ok", isArtifact: true }]);
    for (const bad of [undefined, {}, meta({}), meta("x")]) expect(artifactsOf(bad as Record<string, unknown> | undefined)).toEqual([]);
  });
});

describe("workOf (AHP backgroundWork)", () => {
  it("lists shells and subagents with what to show, stoppable only where the host says so", () => {
    const work = [
      { kind: "shell", id: "shell:1", label: "FICTIONAL dev server", command: "npm run dev", startedAt: AT, _meta: { "vscode.stopBackgroundWork": true } },
      { kind: "shell", id: "shell:2", label: "", command: "tsc -w", startedAt: AT },
      { kind: "subagent", id: "subagent:3", label: "explore", startedAt: AT, chat: "ahp-chat://x" },
      { kind: "other", id: "o", label: "x", startedAt: AT },
      { kind: "shell", label: "no id", startedAt: AT },
    ];
    expect(workOf(work)).toEqual([
      { id: "shell:1", kind: "shell", label: "FICTIONAL dev server", command: "npm run dev", started: AT, stoppable: true },
      { id: "shell:2", kind: "shell", label: "tsc -w", command: "tsc -w", started: AT, stoppable: false },
      { id: "subagent:3", kind: "subagent", label: "explore", started: AT, stoppable: false },
    ]);
    expect(workOf(undefined)).toEqual([]);
  });
});
