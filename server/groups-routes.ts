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
import type { GroupsAnswer } from "../shared/groups.ts";
import type { HostLink, LinkKind } from "../shared/host-chats.ts";
import { createCostsPoller, type CostsPoller } from "./costs-poller.ts";
import type { GroupStore } from "./groups-store.ts";
import { badRequest, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";

/** The digest's model and effort until the owner picks others (spec, section 3). */
export const DIGEST_DEFAULTS: GroupsAnswer["digestDefaults"] = { model: "opencode-go-claude-haiku-5-5", effort: "low" };
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

function answerOf(store: GroupStore): GroupsAnswer {
  return {
    ...store.snapshot(),
    digestDefaults: { model: store.getSetting(DIGEST_MODEL_KEY) ?? DIGEST_DEFAULTS.model, effort: store.getSetting(DIGEST_EFFORT_KEY) ?? DIGEST_DEFAULTS.effort },
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
 */
export async function handleGroupsRequest(request: Request, pathname: string, store: GroupStore, changed: () => void): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const done = (body: unknown = { ok: true }) => { changed(); return reply(body); };
  const exists = (id: number) => store.snapshot().groups.some((group) => group.id === id);
  if (pathname === "/api/groups") {
    setRequestRoute("/api/groups");
    if (request.method === "GET") return reply(answerOf(store));
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
  const match = /^([1-9][0-9]{0,15})\/(rename|delete|add)$/.exec(rest);
  if (!match) return notFound();
  const action = match[2]!;
  setRequestRoute(`/api/groups/:id/${action}`);
  if (request.method !== "POST") return notAllowed(`Use POST /api/groups/<id>/${action}`);
  const id = Number(match[1]);
  if (action === "delete") {
    if (!exists(id)) return noGroup();
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
  const chat = chatOf(body);
  if (chat === null) return badRequest("invalid_body", CHAT_BODY);
  if (!exists(id)) return noGroup();
  store.add(id, chat.pc, chat.session);
  return done();
}
