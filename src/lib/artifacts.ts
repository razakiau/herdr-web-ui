/**
 * A host session's artifacts laid out as VS Code's agent-host pills lay them out (workbench
 * agentHostSessionInputPills, 1.142, read 2026-10-22):
 *
 * - a GitHub PR or issue artifact (`isGitHub` and a github.com link) is a pill of its own, with its
 *   state's icon and colour (`ncs`, `BKn`);
 * - every other artifact goes in the "N artifacts" sheet, in sections by type in VS Code's order
 *   (`ics`), less a website that is one of those PRs' own link (`_buildArtifactSections`);
 * - `isArtifact: false` entries are the References.
 *
 * Pure: the component picks glyphs and colours from `icon` and `tone`.
 */
import type { HostArtifact, HostArtifactType } from "../../shared/host-chats.ts";

export const SECTION_ORDER: readonly HostArtifactType[] = ["pullRequest", "issue", "commit", "website", "file", "resource"];

export interface ArtifactSection { type: HostArtifactType; items: HostArtifact[] }
export interface SessionPills {
  pullRequests: HostArtifact[];
  issues: HostArtifact[];
  sections: ArtifactSection[];
  references: HostArtifact[];
  /** what the "N artifacts" pill counts: the sections' entries */
  count: number;
}

/** A link without its trailing slash and case-folded host, as VS Code compares them (`VKn`). */
export function sameLink(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`;
  } catch {
    return link;
  }
}

function onGitHub(link: string): boolean {
  try {
    const { hostname } = new URL(link);
    return hostname === "github.com" || hostname === "www.github.com" || hostname.endsWith(".github.com") || hostname.startsWith("github.");
  } catch {
    return false;
  }
}

const gitHubOf = (artifact: HostArtifact, type: HostArtifactType): boolean =>
  artifact.isArtifact && artifact.type === type && artifact.isGitHub === true && typeof artifact.link === "string" && onGitHub(artifact.link);

function unique(list: HostArtifact[]): HostArtifact[] {
  const seen = new Set<string>();
  return list.filter((each) => { const key = sameLink(each.link!); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function sessionPills(artifacts: readonly HostArtifact[]): SessionPills {
  const pullRequests = unique(artifacts.filter((each) => gitHubOf(each, "pullRequest")));
  const issues = unique(artifacts.filter((each) => gitHubOf(each, "issue")));
  const pulled = new Set([...pullRequests, ...issues].map((each) => sameLink(each.link!)));
  const rest = artifacts.filter((each) => each.isArtifact && !(each.link !== undefined && pulled.has(sameLink(each.link))));
  const sections = SECTION_ORDER.flatMap((type) => {
    const items = rest.filter((each) => each.type === type);
    return items.length > 0 ? [{ type, items }] : [];
  });
  return { pullRequests, issues, sections, references: artifacts.filter((each) => !each.isArtifact), count: sections.reduce((sum, section) => sum + section.items.length, 0) };
}

export type ReferenceState = "open" | "draft" | "merged" | "closed" | "attention" | "completed" | "not_planned" | "unknown";
export type ArtifactIcon =
  | "pr-open" | "pr-attention" | "pr-draft" | "pr-merged" | "pr-closed"
  | "issue-open" | "issue-done" | "issue-not-planned"
  | "commit" | "website" | "file" | "resource";
/** VS Code's chart colours by name: green open, purple done, red closed, orange needing attention, muted for drafts and not planned. */
export type ArtifactTone = "green" | "purple" | "red" | "orange" | "muted" | "neutral";

/** The glyph and colour of an artifact in its state (`Kq` for PRs, `Nbe` for issues); unknown is the kind's glyph, uncoloured. */
export function artifactLook(artifact: HostArtifact, state: ReferenceState = "unknown"): { icon: ArtifactIcon; tone: ArtifactTone } {
  switch (artifact.type) {
    case "pullRequest":
      return state === "merged" ? { icon: "pr-merged", tone: "purple" }
        : state === "closed" ? { icon: "pr-closed", tone: "red" }
          : state === "draft" ? { icon: "pr-draft", tone: "muted" }
            : state === "attention" ? { icon: "pr-attention", tone: "orange" }
              : { icon: "pr-open", tone: state === "open" ? "green" : "neutral" };
    case "issue":
      return state === "completed" ? { icon: "issue-done", tone: "purple" }
        : state === "not_planned" ? { icon: "issue-not-planned", tone: "muted" }
          : { icon: "issue-open", tone: state === "open" ? "green" : "neutral" };
    default:
      return { icon: artifact.type, tone: "neutral" };
  }
}

/** The pill's short name for a GitHub PR or issue: `#157`, as VS Code labels it from the link; else its label. */
export function shortLabel(artifact: HostArtifact): string {
  const match = artifact.link ? /\/(?:pull|issues)\/(\d+)\/?$/.exec(artifact.link) : null;
  return match ? `#${match[1]}` : artifact.label;
}

/** A local `file:` URI's path (a Windows drive's without the leading slash); null for any other URI. */
export function pathOfFileUri(uri: string): string | null {
  let url: URL;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}
