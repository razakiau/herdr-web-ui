/**
 * The state of a pull request or issue a host chat's session refers to, for its pill's icon and
 * colour (VS Code's `Kq` / `Nbe`, workbench 1.142). One source today, GitHub's REST API, with the
 * token in HERDR_WEB_GITHUB_TOKEN when set (unset: public repos only, 60 requests an hour). Another
 * tracker (Linear) is another `ReferenceStateSource`; a link no source reads is `unknown`.
 */
import { jsonResponse } from "./http.ts";

export type ReferenceState =
  | "open" | "draft" | "merged" | "closed" | "attention"
  | "completed" | "not_planned"
  | "unknown";
export interface ReferenceStateAnswer { state: ReferenceState }
export interface ReferenceStateSource { state(url: string): Promise<ReferenceStateAnswer> }

/** How long an answer is kept: a pill shown on every read must not spend the hour's requests. */
export const REFERENCE_TTL_MS = 5 * 60_000;
/** The most links one request asks about (a session's artifacts are a handful). */
export const MAX_REFERENCE_URLS = 20;
const TIMEOUT_MS = 8_000;

export interface GitHubLink { kind: "pullRequest" | "issue"; owner: string; repo: string; number: number }

/** A github.com PR or issue link; null for any other. */
export function parseGitHubLink(link: string): GitHubLink | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) return null;
  const match = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) return null;
  return { kind: match[3] === "pull" ? "pullRequest" : "issue", owner: match[1]!, repo: match[2]!, number: Number(match[4]) };
}

interface PullBody { state?: string; draft?: boolean; merged?: boolean; mergeable_state?: string }
interface IssueBody { state?: string; state_reason?: string | null }

function pullState(body: PullBody): ReferenceState {
  if (body.merged === true) return "merged";
  if (body.state === "closed") return "closed";
  if (body.draft === true) return "draft";
  // GitHub's "dirty" is a conflict, "unstable" failing checks: VS Code's orange
  return body.mergeable_state === "dirty" || body.mergeable_state === "unstable" ? "attention" : "open";
}

function issueState(body: IssueBody): ReferenceState {
  if (body.state === "open") return "open";
  return body.state_reason === "not_planned" || body.state_reason === "duplicate" ? "not_planned" : "completed";
}

export class GitHubReferenceState implements ReferenceStateSource {
  private readonly cache = new Map<string, { at: number; answer: ReferenceStateAnswer }>();
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(options: { token?: string; fetch?: typeof fetch; now?: () => number } = {}) {
    this.token = options.token ?? process.env.HERDR_WEB_GITHUB_TOKEN ?? "";
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async state(url: string): Promise<ReferenceStateAnswer> {
    const link = parseGitHubLink(url);
    if (link === null) return { state: "unknown" };
    const key = `${link.kind}:${link.owner}/${link.repo}#${link.number}`.toLowerCase();
    const kept = this.cache.get(key);
    if (kept && this.now() - kept.at < REFERENCE_TTL_MS) return kept.answer;
    const answer = await this.ask(link);
    // an unknown is not kept: the next read asks again
    if (answer.state !== "unknown") this.cache.set(key, { at: this.now(), answer });
    return answer;
  }

  private async ask(link: GitHubLink): Promise<ReferenceStateAnswer> {
    const path = link.kind === "pullRequest" ? "pulls" : "issues";
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.token !== "") headers["authorization"] = `Bearer ${this.token}`;
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${link.owner}/${link.repo}/${path}/${link.number}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return { state: "unknown" };
      const body = await response.json() as PullBody & IssueBody;
      return { state: link.kind === "pullRequest" ? pullState(body) : issueState(body) };
    } catch {
      return { state: "unknown" };
    }
  }
}

/** GET /api/references/state?url=…&url=…: each link's state, `unknown` where no source reads it. */
export async function handleReferenceStateRequest(request: Request, source: ReferenceStateSource): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
  const urls = [...new Set(new URL(request.url).searchParams.getAll("url").filter((each) => each !== ""))];
  if (urls.length === 0 || urls.length > MAX_REFERENCE_URLS) {
    return jsonResponse({ error: { code: "bad_urls", message: `between 1 and ${MAX_REFERENCE_URLS} url parameters` } }, 400);
  }
  const answers = await Promise.all(urls.map(async (url) => [url, await source.state(url)] as const));
  return jsonResponse({ states: Object.fromEntries(answers) });
}
