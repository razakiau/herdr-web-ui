/**
 * Chat groups (ZAC-265, Task 8): a group's digest, written on demand from per-chat summaries.
 *
 * Two layers, each cached in groups.sqlite (spec §3):
 *   1. a chat's summary (about five lines), written again only when the chat has a model call newer
 *      than the one its summary saw (`lastCallAt` from the PC's costs answer); an archived chat that
 *      has one is never summarised again. Its input is the chat read through the PC's chat GET,
 *      reduced by `chatInput` (user messages, final replies, the hand-off note, the artifacts).
 *   2. the group's digest, from the summaries only. Over ~60K tokens of summaries they are first
 *      digested per ISO week, then once across the weeks.
 *
 * A digest's links are only ever the members' own artifacts: an `artifactId` the model names that
 * no member has is dropped from its item (the text stays). A bad answer keeps the old digest; the
 * summaries written before it are kept. Every call's cost (OmniRoute's `usage` at the server's price
 * table) is added to the group's spend, a failed run's too.
 */
import type { DigestEffort, DigestEstimate, DigestItem, GroupDigest } from "../shared/groups.ts";
import type { HostArtifact, HostChatRead } from "../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../shared/protocol.ts";
import { priceWithFallback } from "../shared/model-price.ts";
import type { GroupStore } from "./groups-store.ts";
import { DIGEST_EFFORT_KEY, DIGEST_MODEL_KEY } from "./groups-routes.ts";

export interface DigestChoice { model: string; effort: DigestEffort }

/** A model call as OmniRoute answers it (server/omniroute.ts complete). */
export type Complete = (request: { model: string; effort: string; system: string; user: string }) =>
  Promise<{ text: string; usage: { input: number; cached: number; output: number } }>;

export interface DigestDeps {
  store: GroupStore;
  /** a member's chat through its PC's chat GET; null when the PC does not answer */
  readChat(pc: string, session: string): Promise<HostChatRead | null>;
  /** each chat's last model call by `pc session`, from every PC's costs answer (a chat not listed: none known) */
  lastCalls(): Promise<ReadonlyMap<string, string | null>>;
  /** each chat's archived bit by `pc session`, from the PCs' rows */
  archived(): Promise<ReadonlySet<string>>;
  complete: Complete;
  prices(): Promise<{ prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null }>;
  now?(): number;
  /** the run's stage, told as it moves */
  onProgress?(progress: { phase: "summaries" | "group"; done: number; total: number }): void;
}

/** A refresh that failed; `source` names who said so (OmniRoute, or the model's answer). */
export class DigestError extends Error {
  constructor(readonly source: string, message: string) { super(message); }
}

/** A chat's input budget, in tokens. */
export const CHAT_BUDGET = 40_000;
/** Over this many tokens of summaries, the group pass goes week by week first. */
export const GROUP_BUDGET = 60_000;
/** What a chars-per-token guess needs: English prose and code run ~4. */
const CHARS_PER_TOKEN = 4;
export const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const key = (pc: string, session: string): string => `${pc} ${session}`;

/** The artifact list as the model sees it: its id first, so it can name it. */
const artifactLine = (id: string, artifact: HostArtifact): string => `- [${id}] ${artifact.type}: ${artifact.label}${artifact.link ? ` (${artifact.link})` : ""}`;
const artifactLines = (artifacts: readonly HostArtifact[]): string => artifacts.map((artifact) => artifactLine(artifact.id, artifact)).join("\n");

/**
 * The group pass's artifact list: an id is only a chat's own (a1, a2… in each chat), so each
 * member's artifacts get a per-digest index (A1, A2…) mapped back to that chat's artifact. Two chats'
 * `a1` are two entries; one artifact two chats share (the same link) is one.
 */
export function indexArtifacts(lists: readonly { key: string; artifacts: readonly HostArtifact[] }[]): { lines: string; byIndex: Map<string, HostArtifact> } {
  const byIndex = new Map<string, HostArtifact>();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { key: chat, artifacts } of lists) {
    for (const artifact of artifacts) {
      const same = artifact.link ?? artifact.uri ?? `${chat} ${artifact.id}`;
      if (seen.has(same)) continue;
      seen.add(same);
      const index = `A${byIndex.size + 1}`;
      byIndex.set(index, artifact);
      lines.push(artifactLine(index, artifact));
    }
  }
  return { lines: lines.join("\n"), byIndex };
}

/**
 * A chat as the summary call reads it: each user message, each turn's final reply (its
 * `final_answer` text, else its last text: a hand-off note is a final reply too), then the chat's
 * artifacts. Tool calls and reasoning are dropped. Over `budgetTokens`, cut from the middle: the
 * first 30% and the last 70% stay.
 */
export function chatInput(read: HostChatRead, artifacts: readonly HostArtifact[], budgetTokens = CHAT_BUDGET): string {
  const lines: string[] = [];
  for (const turn of read.turns) {
    const texts = turn.parts.flatMap((part) => part.kind === "text" && part.text.trim() ? [part] : []);
    if (turn.role === "user") {
      const said = texts.map((part) => part.text.trim()).join("\n");
      if (said) lines.push(`USER: ${said}`);
      continue;
    }
    const finals = texts.filter((part) => part.phase === "final_answer");
    const reply = (finals.length > 0 ? finals : texts.slice(-1)).map((part) => part.text.trim()).join("\n");
    if (reply) lines.push(`ASSISTANT: ${reply}`);
  }
  const head = `CHAT: ${read.title}\n\n`;
  const tail = artifacts.length > 0 ? `\n\nARTIFACTS:\n${artifactLines(artifacts)}` : "";
  let body = lines.join("\n\n");
  const room = Math.max(0, budgetTokens * CHARS_PER_TOKEN - head.length - tail.length);
  if (body.length > room) {
    const first = Math.floor(room * 0.3);
    const last = room - first;
    body = `${body.slice(0, first)}\n\n[… ${body.length - room} characters cut …]\n\n${body.slice(body.length - last)}`;
  }
  return head + body + tail;
}

const SUMMARY_SYSTEM = `You summarise one coding-agent chat for its owner. Answer a JSON object {"text": string}.
"text" is at most 5 short lines: what the chat did, the decisions made, the PRs and issues it made or touched (by their ids), and what it left open or meant to do next. Plain words, no markdown headings.`;

const WEEK_SYSTEM = `You digest one week of a group of coding-agent chats from their summaries. Answer a JSON object {"text": string}.
"text" is at most 12 short lines: where the work went, what was finished, what is still open (PRs, issues, and things an agent meant to do but did not), naming artifact ids in [brackets] when a summary gives them.`;

const GROUP_SYSTEM = `You write the digest of a group of coding-agent chats that hand work to each other, from their summaries. Answer one JSON object:
{"direction": string, "open": [{"text": string, "artifactId"?: string, "kind"?: "pr"|"issue"|"thread"}], "done": [{"text": string, "artifactId"?: string}], "perChat": [{"session": string, "line": string}]}
- direction: 3 to 4 lines on where the group is going.
- open: open PRs and issues, AND pending threads: things an agent said it would do, or left to do, that no later chat finished. A thread has no artifactId.
- done: finished work, each with the PR or issue it landed in when there is one.
- artifactId: only an index from the ARTIFACTS list (A1, A2…), exactly as written there; leave it out otherwise. Never invent links.
- perChat: one line per chat, its "session" exactly as the CHAT line names it.
Short items, plain words.`;

/**
 * A model's JSON object. A model may still wrap it (`response_format` is a request, and a provider may
 * ignore it): a line of prose before or after, or a ``` fence. When the whole text does not parse, the
 * outermost {…} span (the first "{" to the last "}") is tried. Anything else throws.
 */
export function parseJson(text: string): Record<string, unknown> {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  };
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return object(JSON.parse(trimmed)); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no JSON object");
    return object(JSON.parse(text.slice(start, end + 1)));
  }
}

const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** The cost of one call at the model's price; null when the model has no price. */
export function callCost(model: string, usage: { input: number; cached: number; output: number }, prices: ModelPrices | null, fallback: Record<string, ModelPrice> | null): number | null {
  const price = modelPrice(model, prices, fallback);
  if (!price) return null;
  const cached = Math.min(usage.cached, usage.input);
  return ((usage.input - cached) * price.input + cached * (price.cached ?? price.input) + usage.output * price.output) / 1_000_000;
}

/** A digest model's price: its route (`opencode-go/claude-haiku-5-5`) as named; an older dashed alias `opencode-go-<model>` as that route. */
export function modelPrice(model: string, prices: ModelPrices | null, fallback: Record<string, ModelPrice> | null): ModelPrice | null {
  const table = prices ?? {};
  const routed = /^opencode-go-(.+)$/.exec(model);
  return (priceWithFallback(model, table, fallback) ?? (routed ? priceWithFallback(`opencode-go/${routed[1]}`, table, fallback) : null))?.price ?? null;
}

/** The ISO week a time falls in (`2026-W44`). */
export function isoWeek(ms: number): string {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

interface Member { pc: string; session: string; key: string }

/** Which members a refresh summarises: no summary yet, or a call newer than its summary saw; an archived chat with one, never. */
function needsSummary(store: GroupStore, member: Member, lastCalls: ReadonlyMap<string, string | null>, archived: ReadonlySet<string>): boolean {
  const summary = store.summary(member.pc, member.session);
  if (!summary) return true;
  if (archived.has(member.key)) return false;
  const last = lastCalls.get(member.key) ?? null;
  if (last === null) return false;
  return summary.lastCallSeen === null || Date.parse(last) > Date.parse(summary.lastCallSeen);
}

function membersOf(store: GroupStore, groupId: number): Member[] {
  const group = store.snapshot().groups.find((each) => each.id === groupId);
  if (!group) throw new DigestError("Ovis", "No such group");
  return group.members.map((member) => ({ pc: member.pc, session: member.session, key: key(member.pc, member.session) }));
}

/**
 * Refresh a group's digest with `choice` (spec §3): summarise each member that changed, then one
 * group pass over the summaries (week by week first when they are too long). With nothing changed
 * since the digest (same chats, no new summary, same model and effort) it makes no call and answers
 * the digest as it is. Saves the choice as the default either way. Throws DigestError on a failure:
 * the old digest stays, the summaries written before it stay.
 */
export async function refreshDigest(groupId: number, choice: DigestChoice, deps: DigestDeps): Promise<GroupDigest> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  store.setSetting(DIGEST_MODEL_KEY, choice.model);
  store.setSetting(DIGEST_EFFORT_KEY, choice.effort);
  const members = membersOf(store, groupId);
  const [lastCalls, archived, { prices, fallback }] = await Promise.all([deps.lastCalls(), deps.archived(), deps.prices()]);
  const due = members.filter((member) => needsSummary(store, member, lastCalls, archived));
  let spent = 0;
  const call = async (system: string, user: string): Promise<Record<string, unknown>> => {
    let answer;
    try { answer = await deps.complete({ model: choice.model, effort: choice.effort, system, user }); } catch (error) {
      throw new DigestError("OmniRoute", error instanceof Error ? error.message : "Could not reach OmniRoute");
    }
    const usd = callCost(choice.model, answer.usage, prices, fallback);
    spent += usd ?? 0;
    store.addSpent(groupId, usd);
    try { return parseJson(answer.text); } catch { throw new DigestError(modelName(choice.model), "answered something that is not JSON"); }
  };

  let written = 0;
  for (const [index, member] of due.entries()) {
    deps.onProgress?.({ phase: "summaries", done: index, total: due.length });
    const read = await deps.readChat(member.pc, member.session);
    // a PC that does not answer: its chat keeps the summary it had (or has none), the run goes on
    if (!read) continue;
    const artifacts = read.artifacts ?? [];
    const before = spent;
    const json = await call(SUMMARY_SYSTEM, chatInput(read, artifacts));
    const text = str(json["text"]);
    if (!text) throw new DigestError(modelName(choice.model), "answered a summary with no text");
    store.setSummary({ pc: member.pc, session: member.session, text, lastCallSeen: lastCalls.get(member.key) ?? null, model: choice.model, writtenAt: new Date(now()).toISOString() },
      { effort: choice.effort, costUsd: spent - before, artifacts });
    written += 1;
  }

  const old = store.digest(groupId);
  const seen = new Set(old?.chatsSeen ?? []);
  const sameChats = old !== null && seen.size === members.length && members.every((member) => seen.has(member.key));
  // and no summary newer than the digest: one written by a run whose group pass failed is not in it yet
  const summarisedBefore = old !== null && members.every((member) => {
    const summary = store.summary(member.pc, member.session);
    return !summary || Date.parse(summary.writtenAt) <= Date.parse(old.writtenAt);
  });
  if (old && written === 0 && sameChats && summarisedBefore && old.model === choice.model && old.effort === choice.effort) return old;

  deps.onProgress?.({ phase: "group", done: 0, total: 1 });
  const summaries = members.flatMap((member) => { const summary = store.summary(member.pc, member.session); return summary ? [{ member, summary }] : []; });
  const { lines: artifactList, byIndex: artifacts } = indexArtifacts(summaries.map(({ member, summary }) => ({ key: member.key, artifacts: summary.artifacts })));
  const chatBlock = (each: (typeof summaries)[number]): string => `CHAT ${each.member.key}:\n${each.summary.text}`;
  const all = summaries.map(chatBlock).join("\n\n");
  let material = all;
  if (tokensOf(all) > GROUP_BUDGET) {
    const weeks = new Map<string, typeof summaries>();
    for (const each of summaries) {
      const week = isoWeek(Date.parse(each.summary.lastCallSeen ?? each.summary.writtenAt) || now());
      weeks.set(week, [...(weeks.get(week) ?? []), each]);
    }
    const parts: string[] = [];
    for (const [week, list] of [...weeks].sort((a, b) => a[0].localeCompare(b[0]))) {
      const json = await call(WEEK_SYSTEM, `WEEK ${week}\n\n${list.map(chatBlock).join("\n\n")}`);
      parts.push(`WEEK ${week}:\n${str(json["text"]) ?? ""}\nCHATS THIS WEEK: ${list.map((each) => each.member.key).join(", ")}`);
    }
    material = parts.join("\n\n");
  }
  const json = await call(GROUP_SYSTEM, `${material}\n\nARTIFACTS:\n${artifactList || "(none)"}`);
  const direction = str(json["direction"]);
  if (!direction) throw new DigestError(modelName(choice.model), "answered a digest with no direction");
  const items = (value: unknown): DigestItem[] => (Array.isArray(value) ? value : []).flatMap((item): DigestItem[] => {
    const record = item !== null && typeof item === "object" ? item as Record<string, unknown> : null;
    const text = str(record?.["text"]);
    if (!text) return [];
    const artifact = artifacts.get(str(record?.["artifactId"]) ?? "");
    return [artifact ? { text, artifact } : { text }];
  });
  const byKey = new Map(members.map((member) => [member.key, member]));
  const bySession = new Map(members.map((member) => [member.session, member]));
  const perChat = (Array.isArray(json["perChat"]) ? json["perChat"] : []).flatMap((item) => {
    const record = item !== null && typeof item === "object" ? item as Record<string, unknown> : null;
    const named = str(record?.["session"]) ?? "";
    const member = byKey.get(named) ?? bySession.get(named);
    const line = str(record?.["line"]);
    return member && line ? [{ pc: member.pc, session: member.session, line }] : [];
  });
  const digest: GroupDigest = {
    groupId, direction, open: items(json["open"]), done: items(json["done"]), perChat,
    model: choice.model, effort: choice.effort, costUsd: spent, writtenAt: new Date(now()).toISOString(),
    chatsSeen: members.map((member) => member.key),
  };
  store.setDigest(digest);
  return digest;
}

/** A model id's short name for an error's source (`opencode-go/claude-haiku-5-5` → `claude-haiku-5-5`). */
const modelName = (model: string): string => model.replace(/^.*\//, "").replace(/^opencode-go-/, "");

/** What a summary's answer and the group pass's answer run to, for the estimate. */
const SUMMARY_OUT = 250;
const GROUP_OUT = 1_500;
const PROMPT_TOKENS = 400;

/**
 * What a refresh would cost now (the Refresh sheet's line): the chats it would summarise, the group
 * passes, the tokens it would send and their price. A chat's input is guessed from its last prompt
 * (`context`, capped at the chat budget: the reduced chat is smaller); a summary not yet written as
 * ~SUMMARY_OUT tokens. `usd` null when the model has no price.
 */
export async function estimateDigest(groupId: number, choice: DigestChoice, deps: Pick<DigestDeps, "store" | "lastCalls" | "archived" | "prices"> & {
  contexts(): Promise<ReadonlyMap<string, number | null>>;
}): Promise<DigestEstimate> {
  const { store } = deps;
  const members = membersOf(store, groupId);
  const [lastCalls, archived, contexts, { prices, fallback }] = await Promise.all([deps.lastCalls(), deps.archived(), deps.contexts(), deps.prices()]);
  const due = new Set(members.filter((member) => needsSummary(store, member, lastCalls, archived)).map((member) => member.key));
  let tokensIn = 0;
  let output = 0;
  let summaryTokens = 0;
  for (const member of members) {
    if (due.has(member.key)) {
      tokensIn += PROMPT_TOKENS + Math.min(CHAT_BUDGET, contexts.get(member.key) ?? CHAT_BUDGET / 4);
      output += SUMMARY_OUT;
      summaryTokens += SUMMARY_OUT;
    } else {
      summaryTokens += tokensOf(store.summary(member.pc, member.session)?.text ?? "");
    }
  }
  let groupPasses = 1;
  if (summaryTokens > GROUP_BUDGET) {
    const weeks = new Set(members.map((member) => { const summary = store.summary(member.pc, member.session); return isoWeek(Date.parse(summary?.lastCallSeen ?? summary?.writtenAt ?? "") || Date.now()); }));
    groupPasses = weeks.size + 1;
    tokensIn += summaryTokens + weeks.size * PROMPT_TOKENS + weeks.size * GROUP_OUT + PROMPT_TOKENS;
    output += (weeks.size + 1) * GROUP_OUT;
  } else {
    tokensIn += summaryTokens + PROMPT_TOKENS;
    output += GROUP_OUT;
  }
  const price = modelPrice(choice.model, prices, fallback);
  return { chats: due.size, groupPasses, tokensIn, usd: price ? (tokensIn * price.input + output * price.output) / 1_000_000 : null };
}

// ─── Jobs, and what the server knows of the chats ────────────────────────────

/** What the server knows of every PC's chats for the digest: last calls, last prompts, archived bits, by `pc session`. */
export interface ChatFacts { lastCalls: Map<string, string | null>; contexts: Map<string, number | null>; archived: Set<string> }

/**
 * The chats' facts read from every PC (costs and rows), kept for `freshMs`. `cached()` answers at
 * once (empty before the first read) and starts a read when old, telling `changed` once it lands with
 * something different: GET /api/groups never waits on a PC.
 */
export class ChatFactsCache {
  private facts: ChatFacts = { lastCalls: new Map(), contexts: new Map(), archived: new Set() };
  private readAt = 0;
  private pending: Promise<ChatFacts> | null = null;
  constructor(private readonly read: () => Promise<ChatFacts>, private readonly freshMs: number, private readonly changed: () => void, private readonly now: () => number = Date.now) {}

  cached(): ChatFacts {
    if (this.now() >= this.readAt + this.freshMs) void this.fresh().catch(() => undefined);
    return this.facts;
  }

  /** a read now (one at a time), for a refresh or an estimate */
  fresh(): Promise<ChatFacts> {
    this.pending ??= this.read().then((facts) => {
      const before = JSON.stringify([...this.facts.lastCalls].sort());
      this.facts = facts;
      this.readAt = this.now();
      if (JSON.stringify([...facts.lastCalls].sort()) !== before) this.changed();
      return facts;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

/** Members that moved on since the digest: a newer model call, joined after it, or left since (src/lib/digest.ts staleCount, server side). */
export function staleCount(digest: GroupDigest, members: readonly { pc: string; session: string }[], lastCalls: ReadonlyMap<string, string | null>): number {
  const written = Date.parse(digest.writtenAt);
  const seen = new Set(digest.chatsSeen);
  const now = new Set(members.map((member) => key(member.pc, member.session)));
  let moved = 0;
  for (const each of now) {
    if (!seen.has(each)) { moved += 1; continue; }
    const last = Date.parse(lastCalls.get(each) ?? "");
    if (Number.isFinite(last) && last > written) moved += 1;
  }
  for (const each of seen) if (!now.has(each)) moved += 1;
  return moved;
}

export type JobState = { phase: "summaries" | "group"; done: number; total: number };

/**
 * The digest refreshes this server runs: one per group at a time, each told on the groups event as
 * its stage moves and once it ends; a failure is kept (with its time) until the next run starts.
 */
export class DigestJobs {
  private readonly running = new Map<number, JobState>();
  private readonly failures = new Map<number, { source: string; message: string; at: string }>();
  private nextJob = 1;
  constructor(private readonly deps: Omit<DigestDeps, "onProgress" | "lastCalls" | "archived" | "store"> & {
    /** the store, opened on first use (server/index.ts: no file while groups were never on) */
    store(): GroupStore;
    facts: ChatFactsCache;
    models(): Promise<string[]>;
    changed(): void;
  }) {}

  /** null when a refresh of the group is already running */
  start(groupId: number, choice: DigestChoice): { job: number; done: Promise<void> } | null {
    if (this.running.has(groupId)) return null;
    const job = this.nextJob++;
    this.running.set(groupId, { phase: "summaries", done: 0, total: 0 });
    this.failures.delete(groupId);
    this.deps.changed();
    const done = (async () => {
      try {
        const facts = await this.deps.facts.fresh().catch(() => this.deps.facts.cached());
        await refreshDigest(groupId, choice, { ...this.deps, store: this.deps.store(), lastCalls: async () => facts.lastCalls, archived: async () => facts.archived,
          onProgress: (progress) => { this.running.set(groupId, progress); this.deps.changed(); } });
      } catch (error) {
        const failure = error instanceof DigestError ? error : new DigestError("Ovis", "The digest could not be written");
        this.failures.set(groupId, { source: failure.source, message: failure.message, at: new Date((this.deps.now ?? Date.now)()).toISOString() });
      } finally {
        this.running.delete(groupId);
        this.deps.changed();
      }
    })();
    return { job, done };
  }

  writing(groupId: number): JobState | null { return this.running.get(groupId) ?? null; }
  failure(groupId: number): { source: string; message: string; at: string } | null { return this.failures.get(groupId) ?? null; }

  estimate(groupId: number, choice: DigestChoice): Promise<DigestEstimate> {
    return estimateDigest(groupId, choice, {
      store: this.deps.store(), prices: this.deps.prices,
      lastCalls: async () => (await this.facts()).lastCalls, archived: async () => (await this.facts()).archived, contexts: async () => (await this.facts()).contexts,
    });
  }

  models(): Promise<string[]> { return this.deps.models(); }

  /** the facts as known; a fresh read when none was made yet */
  private facts(): Promise<ChatFacts> {
    const cached = this.deps.facts.cached();
    return cached.lastCalls.size > 0 ? Promise.resolve(cached) : this.deps.facts.fresh().catch(() => cached);
  }

  get factsCache(): ChatFactsCache { return this.deps.facts; }
}
