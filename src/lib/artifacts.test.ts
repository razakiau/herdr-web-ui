import { describe, expect, it } from "bun:test";
import type { HostArtifact } from "../../shared/host-chats.ts";
import { artifactLook, groupState, pathOfFileUri, sessionPills } from "./artifacts.ts";

const a = (id: string, type: HostArtifact["type"], extra: Partial<HostArtifact> = {}): HostArtifact => ({ id, type, label: `FICTIONAL ${id}`, isArtifact: true, ...extra });

describe("sessionPills (VS Code's ncs and _buildArtifactSections)", () => {
  it("pulls GitHub PRs and issues out as their own pills, the rest into sections in VS Code's order, references apart", () => {
    const list = [
      a("f1", "file", { uri: "file:///tmp/fictional/a.md" }),
      a("pr1", "pullRequest", { link: "https://github.com/fictional/repo/pull/1", isGitHub: true }),
      a("pr2", "pullRequest", { link: "https://gitlab.invalid/fictional/repo/-/merge_requests/2" }),
      a("is1", "issue", { link: "https://linear.invalid/FIC-1", isGitHub: false }),
      a("is2", "issue", { link: "https://github.com/fictional/repo/issues/3", isGitHub: true }),
      a("w1", "website", { link: "https://github.com/fictional/repo/pull/1/" }),
      a("w2", "website", { link: "https://example.invalid/docs" }),
      a("c1", "commit", { commitHash: "abc1234" }),
      a("r1", "website", { link: "https://example.invalid/ref", isArtifact: false }),
    ];
    const pills = sessionPills(list);
    expect(pills.pullRequests.map((each) => each.id)).toEqual(["pr1"]);
    expect(pills.issues.map((each) => each.id)).toEqual(["is2"]);
    // the website that is the PR pill's own link is not listed twice
    expect(pills.sections.map((section) => [section.type, section.items.map((each) => each.id)])).toEqual([
      ["pullRequest", ["pr2"]], ["issue", ["is1"]], ["commit", ["c1"]], ["website", ["w2"]], ["file", ["f1"]],
    ]);
    expect(pills.references.map((each) => each.id)).toEqual(["r1"]);
    expect(pills.count).toBe(5);
  });

  it("an empty list makes no pills", () => {
    expect(sessionPills([])).toEqual({ pullRequests: [], issues: [], sections: [], references: [], count: 0 });
  });
});

describe("artifactLook (VS Code's Kq / Nbe icons and colours)", () => {
  it("gives a PR and an issue the state's icon and tone, the kind's own neutral one while unknown", () => {
    const pr = a("p", "pullRequest", { link: "https://github.com/f/r/pull/1", isGitHub: true });
    const issue = a("i", "issue", { link: "https://github.com/f/r/issues/1", isGitHub: true });
    expect(["open", "attention", "draft", "merged", "closed", "unknown"].map((state) => artifactLook(pr, state as never))).toEqual([
      { icon: "pr-open", tone: "green" }, { icon: "pr-attention", tone: "orange" }, { icon: "pr-draft", tone: "muted" },
      { icon: "pr-merged", tone: "purple" }, { icon: "pr-closed", tone: "red" }, { icon: "pr-open", tone: "neutral" },
    ]);
    expect(["open", "completed", "not_planned", "unknown"].map((state) => artifactLook(issue, state as never))).toEqual([
      { icon: "issue-open", tone: "green" }, { icon: "issue-done", tone: "purple" }, { icon: "issue-not-planned", tone: "muted" }, { icon: "issue-open", tone: "neutral" },
    ]);
  });

  it("gives the other kinds VS Code's glyphs: commit, globe, link, and a file its own by extension", () => {
    expect(artifactLook(a("c", "commit"))).toEqual({ icon: "commit", tone: "neutral" });
    expect(artifactLook(a("w", "website"))).toEqual({ icon: "website", tone: "neutral" });
    expect(artifactLook(a("r", "resource"))).toEqual({ icon: "resource", tone: "neutral" });
    expect(artifactLook(a("f", "file", { uri: "file:///x/y.ts" }))).toEqual({ icon: "file", tone: "neutral" });
  });
});

describe("groupState (VS Code's summary pill icon: the most pressing state of the group)", () => {
  it("ranks PRs attention > open > draft > merged > closed, issues open > completed > not planned, unknown last", () => {
    expect(groupState(["closed", "merged", "draft"])).toBe("draft");
    expect(groupState(["merged", "open", "closed"])).toBe("open");
    expect(groupState(["open", "attention"])).toBe("attention");
    expect(groupState(["closed", "merged"])).toBe("merged");
    expect(groupState(["unknown", "closed"])).toBe("closed");
    expect(groupState(["not_planned", "completed"])).toBe("completed");
    expect(groupState(["completed", "open", "not_planned"])).toBe("open");
    expect(groupState([])).toBe("unknown");
  });
});

describe("pathOfFileUri", () => {
  it("reads a file URI's path, decoded, and nothing else", () => {
    expect(pathOfFileUri("file:///tmp/fictional/a%20b.md")).toBe("/tmp/fictional/a b.md");
    expect(pathOfFileUri("file:///C:/fictional/a.md")).toBe("C:/fictional/a.md");
    for (const uri of ["https://x.invalid/a", "file://host/share/a", "nope", "file:///bad%zz"]) expect({ uri, got: pathOfFileUri(uri) }).toEqual({ uri, got: null });
  });
});
