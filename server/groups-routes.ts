/**
 * Chat groups (ZAC-265), the server's side: every PC's hand-off links and host rows are pulled on
 * the cold-cache poll's cadence and filed into the GroupStore, and /api/groups answers and changes
 * the groups. A change is told on /api/machines/events as `{ type: "groups" }`; a page reads
 * /api/groups again then.
 *
 * The links are asked for whole each tick, never `?since=`: `since` filters by the link's own time,
 * and a bridge's first scan finds old links late. Filing is idempotent (GroupStore.addLinks), so a
 * repeat costs a few KB and changes nothing. A PC that does not answer (offline, a timeout, an old
 * bundle without the route) changes nothing either: its members stay.
 */
import type { DigestEffort, GroupDigestAnswer, GroupDigestMeta, GroupsAnswer } from "../shared/groups.ts";
import type { HostLink, LinkKind } from "../shared/host-chats.ts";
import { createCostsPoller, type CostsPoller } from "./costs-poller.ts";
import type { GroupStore } from "./groups-store.ts";
import { goneFrom, staleCount, type DigestJobs } from "./group-digest.ts";
import { OmniRouteError } from "./omniroute.ts";
import { badRequest, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";

/**
 * The digest's model and effort until the owner picks others (spec, section 3). Haiku on the Claude
 * provider, `claude/claude-haiku-5-5` (owner, round 11: the digest is not to spend his OpenCode Go
 * quota); OmniRoute takes slash routes (the dashed `opencode-go-…` form answered 400, 2026-11-02).
 */
// effort medium: the owner's call (2026-11-02, round 10)
export const DIGEST_DEFAULTS: GroupsAnswer["digestDefaults"] = { model: "claude/claude-haiku-5-5", effort: "medium" };
/** The store's `settings` keys for the digest's defaults, once the owner picks (Task 8). */
export const DIGEST_MODEL_KEY = "digestModel";
export const DIGEST_EFFORT_KEY = "digestEffort";

const MAX_NAME = 200;
const MAX_ID = 512;
const LINK_KINDS: readonly LinkKind[] = ["job", "resume", "spawn", "continue", "fork"];

/** A host row as the store files a fork from it. */
export type GroupsRow = { session: string; title: string; fork_of?: string };
/** What one PC answered: its links (row ids) and its rows. */
export type PcChats = { links: HostLink[]; rows: GroupsRow[] };
/** One PC to pull: `read` answers null (or throws) when the PC said nothing usable. */
export type GroupsPcSource = { pc: string; read: () => Promise<PcChats | null> };

const text = (value: unknown, max: number): value is string => typeof value === "string" && value !== "" && value.length <= max;

function linksOf(value: unknown): HostLink[] | null {
  if (!isJsonObject(value) || !Array.isArray(value["links"])) return null;
  return value["links"].flatMap((link): HostLink[] => isJsonObject(link) && text(link["from"], MAX_ID) && text(link["to"], MAX_ID) && typeof link["at"] === "string"
    && LINK_KINDS.includes(link["kind"] as LinkKind) ? [{ from: link["from"], to: link["to"], kind: link["kind"] as LinkKind, at: link["at"] }] : []);
}

function rowsOf(value: unknown): GroupsRow[] | null {
  if (!isJsonObject(value) || !Array.isArray(value["chats"])) return null;
  return value["chats"].flatMap((row): GroupsRow[] => {
    if (!isJsonObject(row) || !text(row["session"], MAX_ID)) return [];
    const title = typeof row["title"] === "string" ? row["title"] : "";
    return [{ session: row["session"], title, ...(text(row["fork_of"], MAX_ID) ? { fork_of: row["fork_of"] } : {}) }];
  });
}

/**
 * Another PC's links and rows over its bridge, `get` being index.ts's remoteJson on that PC's
 * endpoint (null on a non-2xx, a timeout or a network failure). Both or nothing: links without the
 * rows could name chats by their log ids (a host that was down), which no row would ever match.
 */
export async function remotePcChats(get: <T>(path: string, timeoutMs: number) => Promise<T | null>): Promise<PcChats | null> {
  const [links, rows] = await Promise.all([get<unknown>("/api/host-chats/links", 60_000), get<unknown>("/api/host-chats/chats", 15_000)]);
  const linkList = linksOf(links);
  const rowList = rowsOf(rows);
  return linkList && rowList ? { links: linkList, rows: rowList } : null;
}

/** One pull: every PC's links and forks into the store; `changed` once when anything was filed. Answers the count filed. */
export async function pullGroups(store: GroupStore, sources: GroupsPcSource[], changed: () => void): Promise<number> {
  const answers = await Promise.all(sources.map(async (source) => {
    try { return { pc: source.pc, chats: await source.read() }; } catch { return { pc: source.pc, chats: null }; }
  }));
  let filed = 0;
  for (const { pc, chats } of answers) {
    if (!chats) continue;
    const titles = new Map(chats.rows.map((row) => [row.session, row.title]));
    filed += store.addLinks(pc, chats.links, titles).filed;
    filed += store.addForks(pc, chats.rows).filed;
  }
  if (filed > 0) changed();
  return filed;
}

/** The poll (server/costs-poller.ts): one pull at a time, none while chat groups are off. */
export function createGroupsPoller({ store, intervalMs, wanted, sources, changed }: {
  store: () => GroupStore; intervalMs: number; wanted: () => boolean; sources: () => GroupsPcSource[]; changed: () => void;
}): CostsPoller {
  return createCostsPoller({ intervalMs, wanted, read: async () => { await pullGroups(store(), sources(), changed); } });
}

/** Tells the PC event stream's listeners that the groups changed (server/machine-api.ts). */
export class GroupsSignal {
  private readonly listeners = new Set<() => void>();
  tell(): void { for (const listener of [...this.listeners]) listener(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Direction's first two lines, for a Groups card. */
const firstLines = (text: string): string => text.split(/\n+/).slice(0, 2).join("\n");

/** The model a refresh uses for a saved or sent id: the default when there is none or it is not allowed. */
const digestModelOf = (id: string | null, digests: DigestJobs | null): string =>
  id === null ? DIGEST_DEFAULTS.model : digests?.allowedModel(id, DIGEST_DEFAULTS.model) ?? id;

function answerOf(store: GroupStore, digests: DigestJobs | null): GroupsAnswer {
  const snapshot = store.snapshot();
  // the PCs' last calls are read (every PC's costs) only while some group has a digest to call stale
  const facts = snapshot.digests.length > 0 ? digests?.factsCache.cached() ?? null : null;
  const lastCalls = facts?.lastCalls ?? new Map<string, string | null>();
  // a chat its PC no longer lists (deleted) is not one that moved on: it left the digest's input
  const listed = facts?.listed ?? new Map<string, Set<string>>();
  const members = new Map(snapshot.groups.map((group) => [group.id, group.members.filter((member) => !goneFrom(listed, member.pc, member.session))]));
  const metas: GroupDigestMeta[] = snapshot.digests.map((digest) => ({
    groupId: digest.groupId, writtenAt: digest.writtenAt, costUsd: digest.costUsd, model: digest.model, effort: digest.effort,
    direction: firstLines(digest.direction), staleCount: staleCount(digest, members.get(digest.groupId) ?? [], lastCalls, listed), spentUsd: store.spent(digest.groupId), spendIncomplete: store.spendIncomplete(digest.groupId),
  }));
  return {
    ...snapshot,
    digests: metas,
    // the saved pick, unless the picker no longer offers it (chosen from an older list): then the default; the effort sticks
    digestDefaults: { model: digestModelOf(store.getSetting(DIGEST_MODEL_KEY), digests), effort: store.getSetting(DIGEST_EFFORT_KEY) ?? DIGEST_DEFAULTS.effort },
  };
}

type Chat = { pc: string; session: string };
const chatOf = (value: unknown): Chat | null => isJsonObject(value) && text(value["pc"], MAX_ID) && text(value["session"], MAX_ID) ? { pc: value["pc"], session: value["session"] } : null;
const nameOf = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME ? value.trim() : null;
const CHAT_BODY = "Send { pc, session }";
const notFound = () => jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
const noGroup = () => jsonResponse({ error: { code: "group_not_found", message: "no such group" } }, 404);
const notAllowed = (use: string) => jsonResponse({ error: { code: "method_not_allowed", message: use } }, 405);

/**
 * /api/groups and /api/groups/…: GET the groups (GroupsAnswer); POST a change, which answers
 * `{ ok: true }` (or `{ id }` for a new group) and calls `changed`. A change naming a group that
 * does not exist is 404 `group_not_found`; a split of a chat in no group is 400 `not_in_group`.
 * POST /api/groups/<id>/merge `{ into }` moves every chat to `into` and deletes the group. A merge or a
 * delete while a digest is being written for either group is 409 `digest_running`.
 */
export async function handleGroupsRequest(request: Request, pathname: string, store: GroupStore, changed: () => void,
  digest: { on(): boolean; jobs: DigestJobs | null } = { on: () => true, jobs: null }): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const done = (body: unknown = { ok: true }) => { changed(); return reply(body); };
  const exists = (id: number) => store.snapshot().groups.some((group) => group.id === id);
  if (pathname === "/api/groups") {
    setRequestRoute("/api/groups");
    if (request.method === "GET") return reply(answerOf(store, digest.jobs));
    if (request.method !== "POST") return notAllowed("Use GET or POST /api/groups");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const name = nameOf(body["name"]);
    if (name === null) return badRequest("invalid_body", `Send { name: 1 to ${MAX_NAME} characters, first?: { pc, session } }`);
    const first = body["first"] === undefined ? undefined : chatOf(body["first"]);
    if (first === null) return badRequest("invalid_body", "first is { pc, session }");
    return done({ id: store.create(name, first) });
  }
  const rest = pathname.slice("/api/groups/".length);
  const digestRoute = /^(?:models|([1-9][0-9]{0,15})\/digest(\/estimate)?)$/.exec(rest);
  if (digestRoute) return digestRequest(request, url(request), digestRoute, store, digest);
  if (rest === "remove" || rest === "split") {
    setRequestRoute(`/api/groups/${rest}`);
    if (request.method !== "POST") return notAllowed(`Use POST /api/groups/${rest}`);
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const chat = chatOf(body);
    if (chat === null) return badRequest("invalid_body", CHAT_BODY);
    if (rest === "remove") { store.remove(chat.pc, chat.session); return done(); }
    if (!store.snapshot().groups.some((group) => group.members.some((member) => member.pc === chat.pc && member.session === chat.session))) {
      return badRequest("not_in_group", "This chat is in no group");
    }
    return done({ id: store.split(chat.pc, chat.session) });
  }
  const match = /^([1-9][0-9]{0,15})\/(rename|delete|add|merge)$/.exec(rest);
  if (!match) return notFound();
  const action = match[2]!;
  setRequestRoute(`/api/groups/:id/${action}`);
  if (request.method !== "POST") return notAllowed(`Use POST /api/groups/<id>/${action}`);
  const id = Number(match[1]);
  // a digest being written for a group would land its spend and digest on a group that is gone
  const running = (...ids: number[]) => ids.some((each) => digest.jobs?.writing(each) != null);
  const busy = () => jsonResponse({ error: { code: "digest_running", message: "A digest is being written for this group; try again when it is done" } }, 409);
  if (action === "delete") {
    if (!exists(id)) return noGroup();
    if (running(id)) return busy();
    store.delete(id);
    return done();
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (action === "rename") {
    const name = nameOf(body["name"]);
    if (name === null) return badRequest("invalid_body", `Send { name: 1 to ${MAX_NAME} characters }`);
    if (!exists(id)) return noGroup();
    store.rename(id, name);
    return done();
  }
  if (action === "merge") {
    const into = body["into"];
    if (typeof into !== "number" || !Number.isSafeInteger(into) || into < 1 || into === id) return badRequest("invalid_body", "Send { into: another group's id }");
    if (!exists(id) || !exists(into)) return noGroup();
    if (running(id, into)) return busy();
    store.merge(id, into);
    return done();
  }
  const chat = chatOf(body);
  if (chat === null) return badRequest("invalid_body", CHAT_BODY);
  if (!exists(id)) return noGroup();
  store.add(id, chat.pc, chat.session);
  return done();
}

const url = (request: Request): URL => new URL(request.url, "http://localhost");
const EFFORTS: readonly DigestEffort[] = ["low", "medium", "high"];
const MAX_MODEL = 200;
const modelOf = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(value) && value.length <= MAX_MODEL ? value : null;
const effortOf = (value: unknown): DigestEffort | null => EFFORTS.includes(value as DigestEffort) ? value as DigestEffort : null;

/**
 * The digest's routes (ZAC-265 PR 2), only while Settings → Chat groups is on (404 `groups_off`):
 *   GET  /api/groups/models                          `{ models }`, OmniRoute's ids (kept 10 min)
 *   GET  /api/groups/<id>/digest                     GroupDigestAnswer: the digest, the run's stage, its failure, the spend
 *   POST /api/groups/<id>/digest {model, effort}     starts a refresh, `{ job }` at once; 409 `digest_running` while one runs
 *   GET  /api/groups/<id>/digest/estimate?model=&effort=   DigestEstimate
 * A watching device's POST is refused before this (server/index.ts, read_only).
 */
async function digestRequest(request: Request, address: URL, match: RegExpExecArray, store: GroupStore, digest: { on(): boolean; jobs: DigestJobs | null }): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const jobs = digest.jobs;
  setRequestRoute(match[1] === undefined ? "/api/groups/models" : match[2] ? "/api/groups/:id/digest/estimate" : "/api/groups/:id/digest");
  if (!digest.on()) return jsonResponse({ error: { code: "groups_off", message: "Chat groups are off" } }, 404);
  if (!jobs) return notFound();
  if (match[1] === undefined) {
    if (request.method !== "GET") return notAllowed("Use GET /api/groups/models");
    try { return reply({ models: await jobs.models() }); } catch (error) {
      // OmniRoute's own refusal as it said it (409 digest_unavailable: no API key), else a fixed 502
      if (error instanceof OmniRouteError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      return jsonResponse({ error: { code: "models_unavailable", message: "Could not reach OmniRoute" } }, 502);
    }
  }
  const id = Number(match[1]);
  if (!store.snapshot().groups.some((group) => group.id === id)) return noGroup();
  if (match[2]) {
    if (request.method !== "GET") return notAllowed("Use GET /api/groups/<id>/digest/estimate");
    const model = modelOf(address.searchParams.get("model"));
    const effort = effortOf(address.searchParams.get("effort"));
    if (!model || !effort) return badRequest("invalid_query", "Send ?model=<id>&effort=low|medium|high");
    return reply(await jobs.estimate(id, { model, effort }));
  }
  if (request.method === "GET") {
    const writing = jobs.writing(id);
    const error = jobs.failure(id);
    const answer: GroupDigestAnswer = { digest: store.digest(id), spentUsd: store.spent(id), spendIncomplete: store.spendIncomplete(id), ...(writing ? { writing } : {}), ...(error ? { error } : {}) };
    return reply(answer);
  }
  if (request.method !== "POST") return notAllowed("Use GET or POST /api/groups/<id>/digest");
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const model = modelOf(body["model"]);
  const effort = effortOf(body["effort"]);
  if (!model || !effort) return badRequest("invalid_body", "Send { model, effort: low|medium|high }");
  const started = jobs.start(id, { model: digestModelOf(model, jobs), effort });
  if (!started) return jsonResponse({ error: { code: "digest_running", message: "This group's digest is being written" } }, 409);
  return reply({ job: started.job });
}
