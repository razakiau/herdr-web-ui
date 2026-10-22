import { describe, expect, it } from "bun:test";
import { GitHubReferenceState, handleReferenceStateRequest, parseGitHubLink, REFERENCE_TTL_MS, type ReferenceState } from "./references.ts";

type Answer = { status: number; body: unknown };
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const answer = answers[url] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { fetcher: fetcher as typeof fetch, calls };
}

const PR = "https://api.github.com/repos/fictional/repo/pulls/7";
const ISSUE = "https://api.github.com/repos/fictional/repo/issues/9";

describe("parseGitHubLink", () => {
  it("reads a PR or issue link on github.com, and nothing else", () => {
    expect(parseGitHubLink("https://github.com/fictional/repo/pull/7")).toEqual({ kind: "pullRequest", owner: "fictional", repo: "repo", number: 7 });
    expect(parseGitHubLink("https://www.github.com/fictional/repo/issues/9/")).toEqual({ kind: "issue", owner: "fictional", repo: "repo", number: 9 });
    for (const link of ["https://github.com/fictional/repo", "https://evil.invalid/fictional/repo/pull/7", "https://github.com/fictional/repo/pull/7x", "nope", "https://github.com/a/b/pull/0"]) {
      expect({ link, got: parseGitHubLink(link) }).toEqual({ link, got: null });
    }
  });
});

describe("GitHubReferenceState", () => {
  it("names a PR's state as VS Code colours it: open, draft, merged, closed, and open with failing checks", async () => {
    const pulls = (body: object) => fakeFetch({ [PR]: { status: 200, body } });
    const cases: [object, ReferenceState][] = [
      [{ state: "open", draft: false, merged: false, mergeable_state: "clean" }, "open"],
      [{ state: "open", draft: true, merged: false }, "draft"],
      [{ state: "closed", merged: true }, "merged"],
      [{ state: "closed", merged: false }, "closed"],
      [{ state: "open", draft: false, merged: false, mergeable_state: "dirty" }, "attention"],
      [{ state: "open", draft: false, merged: false, mergeable_state: "unstable" }, "attention"],
    ];
    for (const [body, state] of cases) {
      const source = new GitHubReferenceState({ token: "FICTIONAL", fetch: pulls(body).fetcher });
      expect({ body, got: await source.state("https://github.com/fictional/repo/pull/7") }).toEqual({ body, got: { state } });
    }
  });

  it("names an issue open, completed or not planned", async () => {
    const cases: [object, ReferenceState][] = [[{ state: "open" }, "open"], [{ state: "closed", state_reason: "completed" }, "completed"], [{ state: "closed", state_reason: "not_planned" }, "not_planned"], [{ state: "closed", state_reason: "duplicate" }, "not_planned"]];
    for (const [body, state] of cases) {
      const source = new GitHubReferenceState({ token: "", fetch: fakeFetch({ [ISSUE]: { status: 200, body } }).fetcher });
      expect({ body, got: await source.state("https://github.com/fictional/repo/issues/9") }).toEqual({ body, got: { state } });
    }
  });

  it("sends the token when there is one, none when not, and keeps an answer for its TTL", async () => {
    let now = 1_000;
    const { fetcher, calls } = fakeFetch({ [PR]: { status: 200, body: { state: "open", draft: false, merged: false } } });
    const source = new GitHubReferenceState({ token: "FICTIONAL-TOKEN", fetch: fetcher, now: () => now });
    await source.state("https://github.com/fictional/repo/pull/7");
    await source.state("https://github.com/fictional/repo/pull/7");
    expect(calls.map((each) => each.auth)).toEqual(["Bearer FICTIONAL-TOKEN"]);
    now += REFERENCE_TTL_MS + 1;
    await source.state("https://github.com/fictional/repo/pull/7");
    expect(calls).toHaveLength(2);
    const bare = fakeFetch({ [PR]: { status: 200, body: { state: "open" } } });
    await new GitHubReferenceState({ token: "", fetch: bare.fetcher }).state("https://github.com/fictional/repo/pull/7");
    expect(bare.calls[0]!.auth).toBeNull();
  });

  it("an error, a refusal or a link it cannot read says unknown, and never throws", async () => {
    const source = new GitHubReferenceState({ token: "", fetch: fakeFetch({ [PR]: { status: 403, body: { message: "rate limited" } } }).fetcher });
    expect(await source.state("https://github.com/fictional/repo/pull/7")).toEqual({ state: "unknown" });
    expect(await source.state("https://linear.invalid/FIC/issue/FIC-1")).toEqual({ state: "unknown" });
    const broken = new GitHubReferenceState({ token: "", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await broken.state("https://github.com/fictional/repo/pull/7")).toEqual({ state: "unknown" });
  });
});

describe("handleReferenceStateRequest", () => {
  it("answers each url's state, at most 20, and refuses a request with none", async () => {
    const source = { state: async (url: string) => ({ state: url.endsWith("/7") ? "merged" : "unknown" }) };
    const ask = (query: string) => handleReferenceStateRequest(new Request(`http://x/api/references/state?${query}`), source as never);
    const answer = await ask("url=https://github.com/a/b/pull/7&url=https://x.invalid/1");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ states: { "https://github.com/a/b/pull/7": { state: "merged" }, "https://x.invalid/1": { state: "unknown" } } });
    expect((await ask("")).status).toBe(400);
    expect((await ask(Array.from({ length: 21 }, (_, at) => `url=https://x.invalid/${at}`).join("&"))).status).toBe(400);
    expect((await handleReferenceStateRequest(new Request("http://x/api/references/state?url=a", { method: "POST" }), source as never)).status).toBe(405);
  });
});
