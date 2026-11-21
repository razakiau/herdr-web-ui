/**
 * Live consistency harness for host chat loading (ZAC-340): drives the real client code
 * (src/lib/chatSource.ts hostSource, src/lib/hostChats.ts fetchHostChat / fetchHostChatPage and the
 * kept-read cache) against a running Ovis server, and checks what a ChatView would show against the
 * chat as the old client read it (a plain read, then `before=<cursor>` until no cursor).
 *
 *   OVIS_TOKEN=… bun scripts/chat-consistency.ts [--url https://host] [--machines id,id]
 *     [--limit N] [--delta-minutes M] [--working N] [--concurrency N]
 *
 * The token is read from OVIS_TOKEN and never printed. Nothing of a chat's content is printed:
 * mismatches name host turn ids (shortened) and positions only. Exits 1 on any mismatch.
 *
 * Per chat:
 * 1. reference: plain read, then `before` pages (each prepends the turns ahead of the last start);
 * 2. client: hostSource(…, {keep: true}).read(), its "/" follow-ups (COMMANDS_FOLLOW_UPS through
 *    onChange), then read({before}) until no cursor, ChatView's way (older pages prepend, the newest
 *    page is read `from` the first page's cursor once one is held); the shown turns must equal the
 *    reference host turn by host turn (no gap, no duplicate, same content);
 * 3. "/": the screen's read (keepShownRead over onRead) must carry commands when the plain read
 *    does, and never go from some to none;
 * 4. on busy chats, for --delta-minutes: newest re-reads (known/anchor deltas) and simulated reloads
 *    (stored() then read() from a fresh memory over the same store), each checked against a fresh
 *    reference; and page-backs interleaved with those reads while the chat changes (a 409
 *    history_changed is ChatView's reload, counted; never a silent gap or duplicate).
 */
import { createHash } from "node:crypto";
import type { HostChatRead } from "../shared/host-chats.ts";
import type { ConversationResponse, ConversationTurn } from "../shared/protocol.ts";
import type { HostReadStore } from "../src/lib/hostChatStore.ts";

// ─── options ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const BASE = opt("url", process.env.OVIS_URL ?? "https://herdr.lab.zackautocracy.me").replace(/\/$/, "");
const TOKEN = process.env.OVIS_TOKEN ?? "";
if (!TOKEN) { console.error("OVIS_TOKEN is not set"); process.exit(2); }
const MACHINES = opt("machines", "ea8df1e3-f3af-e72d-42f0-43b8ef216b83").split(",").filter(Boolean);
const LIMIT = Number(opt("limit", "100000"));
const DELTA_MINUTES = Number(opt("delta-minutes", "3"));
const WORKING = Number(opt("working", "3"));
const CONCURRENCY = Number(opt("concurrency", "2"));

// ─── the network: the client's relative URLs go to BASE, with the token ────

const realFetch = globalThis.fetch;
const stats = {
  requests: 0, reference: 0, tail: 0, known: 0, anchor: 0, deltaAnswers: 0, commandsSame: 0, deferred: 0, pageBefore: 0,
  hostBefore: 0, status409: 0,
};
const withAuth = (init?: RequestInit): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  headers.set("x-herdr-machine", "1");
  headers.set("origin", BASE);
  return { ...init, headers };
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const full = url.startsWith("/") ? `${BASE}${url}` : url;
  stats.requests += 1;
  const referenceCall = new Headers(init?.headers).has("x-harness-ref");
  if (referenceCall) stats.reference += 1;
  else {
    const q = new URL(full).searchParams;
    if (q.has("tail")) stats.tail += 1;
    if (q.has("known")) stats.known += 1;
    if (q.has("anchor")) stats.anchor += 1;
    if (q.has("page_before")) stats.pageBefore += 1;
    if (q.has("before")) stats.hostBefore += 1;
  }
  const response = await realFetch(full, withAuth(init));
  if (response.status === 409) stats.status409 += 1;
  if (!referenceCall && response.ok && full.includes("host-chats/chat?")) {
    // count what the answer was, without touching the body the client reads
    const body = await response.clone().json().catch(() => null) as Partial<HostChatRead> | null;
    if (body?.delta !== undefined) stats.deltaAnswers += 1;
    if (body?.commands_same === true) stats.commandsSame += 1;
    if (body?.commands_deferred === true) stats.deferred += 1;
  }
  return response;
}) as typeof fetch;

const { hostSource, keepShownRead } = await import("../src/lib/chatSource.ts");
const { setHostReadStore, flushHostChat } = await import("../src/lib/hostChats.ts");
const { ApiError } = await import("../src/lib/api.ts");

/** the device's store, in memory: what IndexedDB would hold across a reload */
const stored = new Map<string, string>();
const memoryStore: HostReadStore = {
  get: async (key) => stored.get(key) ?? null,
  put: async (key, json) => { stored.set(key, json); },
  delete: async (key) => { stored.delete(key); },
};
setHostReadStore(memoryStore);

// ─── the reference: the old client's reads ──────────────────────────────────

const short = (id: string | undefined): string => (id ?? "?").slice(0, 8);
const h = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);

interface Pair { user: string; full: string }
interface Ref { ids: string[]; pairs: Pair[]; commands: number; busy: boolean; status: string; signature: string; steps: number; bytes: number }

/** a reference read: counted apart from the client's */
const REF: RequestInit = { headers: { "x-harness-ref": "1" } };

async function raw(machine: string, session: string, query: Record<string, string>): Promise<HostChatRead> {
  const response = await globalThis.fetch(`/api/machines/${machine}/host-chats/chat?${new URLSearchParams({ session, ...query }).toString()}`, REF);
  if (!response.ok) {
    const code = ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? "?";
    throw new Error(`reference read${query.before === undefined ? "" : " before"} ${response.status} ${code}`);
  }
  return await response.json() as HostChatRead;
}

const pairsOf = (turns: ConversationTurn[]): Pair[] => {
  const out: Pair[] = [];
  for (let i = 0; i + 1 < turns.length; i += 2) out.push({ user: h(turns[i]), full: h([turns[i], turns[i + 1]]) });
  return out;
};

/** The whole chat the old way: a plain read, then `before` its cursor until none. */
async function reference(machine: string, session: string, attempts = 3): Promise<Ref> {
  for (let attempt = 1; ; attempt++) {
    const read = await raw(machine, session, {});
    if (read.turns.length % 2 !== 0) throw new Error(`odd turn count ${read.turns.length}`);
    let ids = read.message_ids.slice(0, read.turns.length / 2);
    let turns = read.turns;
    let cursor = read.cursor;
    let steps = 0;
    let broken = false;
    while (cursor !== null) {
      steps += 1;
      const older = await raw(machine, session, { before: cursor });
      const olderIds = older.message_ids.slice(0, older.turns.length / 2);
      const at = ids.length === 0 ? olderIds.length : olderIds.indexOf(ids[0]!);
      if (at < 0) { broken = true; break; }
      ids = [...olderIds.slice(0, at), ...ids];
      turns = [...older.turns.slice(0, 2 * at), ...turns];
      cursor = older.cursor;
    }
    if (!broken) return { ids, pairs: pairsOf(turns), commands: read.commands?.length ?? 0, busy: read.busy, status: read.status, signature: read.signature, steps, bytes: JSON.stringify(turns).length };
    if (attempt >= attempts) throw new Error("reference: the window moved under its pages");
  }
}

// ─── the client, ChatView's way ─────────────────────────────────────────────

interface Mismatch { chat: string; phase: string; kind: string; detail: string }
const mismatches: Mismatch[] = [];
const counts = { chats: 0, turns: 0, maxTurns: 0, pageBacks: 0, newestReads: 0, deltaChecks: 0, reloadChecks: 0, raceChecks: 0, raceReloads: 0, commandsChecked: 0, moved: 0, statuses: {} as Record<string, number>, errors: 0, hostSkipped: [] as string[], referenceBeforeSteps: 0, maxBytes: 0, sizes: { "<100KB": 0, "<1MB": 0, "<10MB": 0, ">=10MB": 0 } as Record<string, number> };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const is409 = (cause: unknown): boolean => cause instanceof ApiError && cause.status === 409;

class Emu {
  src: ReturnType<typeof hostSource>;
  older: ConversationTurn[] = [];
  heldFrom: string | undefined;
  olderCursor: string | null = null;
  newest: ConversationResponse | null = null;
  previous: ConversationResponse | null = null;
  screen: HostChatRead | null = null;
  followUps = 0;
  history409 = 0;
  constructor(readonly machine: string, readonly session: string, readonly name: string, readonly phase: () => string) {
    this.src = hostSource(machine, session, { keep: true });
    this.src.onRead((read) => {
      const before = this.screen;
      const next = keepShownRead(before, read);
      if (before !== null && (before.commands?.length ?? 0) > 0 && (next.commands?.length ?? 0) === 0) {
        mismatches.push({ chat: name, phase: phase(), kind: "commands-emptied", detail: `screen commands ${before.commands.length} -> ${next.commands?.length ?? "undefined"} (deferred=${next.commands_deferred === true})` });
      }
      this.screen = next;
    });
    this.src.onChange(() => { this.followUps += 1; });
  }
  dropOlder(): void { this.older = []; this.heldFrom = undefined; this.olderCursor = null; }
  /** ChatView's read(): the newest page, `from` the held start once older pages are held */
  async readNewest(): Promise<void> {
    counts.newestReads += 1;
    let conversation: ConversationResponse;
    try {
      conversation = await this.src.read(this.heldFrom === undefined ? {} : { from: this.heldFrom });
    } catch (cause) {
      if (this.heldFrom === undefined || !is409(cause)) throw cause;
      this.history409 += 1;
      this.dropOlder(); this.previous = null;
      conversation = await this.src.read();
    }
    const held = this.heldFrom ?? (this.previous?.history_id === conversation.history_id ? this.previous?.cursor : undefined);
    if (held !== undefined && typeof conversation.cursor === "string" && conversation.cursor !== held) {
      // ChatView's turnsBetween asks with `since`, which a host chat refuses: older pages drop, and it reads again
      counts.moved += 1;
      this.dropOlder(); this.previous = null; this.newest = null;
      return this.readNewest();
    }
    if (this.heldFrom === undefined) this.olderCursor = conversation.cursor ?? null;
    this.newest = conversation;
    this.previous = conversation;
  }
  /** a read, then the reads its change listeners ask for at once (the "/" follow-ups) */
  async settle(): Promise<void> {
    await this.readNewest();
    await tick();
    for (let guard = 0; this.followUps > 0 && guard < 10; guard++) {
      this.followUps = 0;
      await this.readNewest();
      await tick();
    }
  }
  /** ChatView's loadOlder() */
  async pageBack(): Promise<"paged" | "reloaded" | "none"> {
    if (typeof this.olderCursor !== "string") return "none";
    const before = this.olderCursor;
    counts.pageBacks += 1;
    let page: ConversationResponse;
    try { page = await this.src.read({ before }); }
    catch (cause) {
      if (!is409(cause)) throw cause;
      this.history409 += 1;
      this.dropOlder(); this.previous = null;
      await this.readNewest();
      return "reloaded";
    }
    const first = this.heldFrom === undefined;
    this.heldFrom ??= before;
    this.older = [...page.turns, ...this.older];
    this.olderCursor = page.cursor ?? null;
    if (first) await this.readNewest();
    return "paged";
  }
  shown(): ConversationTurn[] { return [...this.older, ...(this.newest?.turns ?? [])]; }
}

/**
 * The shown turns against the chat: contiguous host turns of the reference (from its first when
 * `complete`), the same content each (the last shown host turn by its user turn alone while the
 * chat runs, as it may still be answering; any turn may match `before`, a reference taken before the
 * client's read). Turns after the shown ones are allowed only on a chat that changed meanwhile.
 */
function compare(shown: ConversationTurn[], ref: Ref, before: Ref | null, complete: boolean, volatile: boolean): string | null {
  if (shown.length % 2 !== 0) return `odd shown turn count ${shown.length}`;
  const pairs = pairsOf(shown);
  if (pairs.length === 0) return ref.pairs.length === 0 || !complete ? null : `nothing shown, the chat has ${ref.pairs.length} host turns`;
  const okAt = (i: number, j: number, last: boolean): boolean => {
    const p = pairs[i]!;
    const r = ref.pairs[j];
    if (r === undefined) return false;
    if (p.full === r.full || (last && volatile && p.user === r.user)) return true;
    // the same turn as the reference taken before the read had it
    const id = ref.ids[j];
    const k = before === null || id === undefined ? -1 : before.ids.indexOf(id);
    return k >= 0 && (before!.pairs[k]!.full === p.full || (last && volatile && before!.pairs[k]!.user === p.user));
  };
  const fits = (start: number): number => {
    for (let i = 0; i < pairs.length; i++) if (!okAt(i, start + i, i === pairs.length - 1)) return i;
    return -1;
  };
  const starts = complete ? [0] : ref.pairs.map((_, j) => j).filter((j) => okAt(0, j, pairs.length === 1));
  let best = { start: 0, at: 0 };
  for (const start of starts) {
    const at = fits(start);
    if (at < 0) {
      const after = ref.pairs.length - (start + pairs.length);
      if (after > 0 && !volatile) return `shown ends ${after} host turns before the chat's last (${short(ref.ids[start + pairs.length])}) on an unchanged chat`;
      return null;
    }
    if (at > best.at) best = { start, at };
  }
  if (starts.length === 0) return `shown first host turn not found in the chat (${pairs.length} shown, ${ref.pairs.length} in the chat)`;
  const j = best.start + best.at;
  // tell a duplicate from a gap: the shown turn at the break is the reference's turn some steps before/after
  const p = pairs[best.at]!;
  const elsewhere = ref.pairs.findIndex((r) => r.full === p.full);
  const what = elsewhere < 0 ? "content differs" : elsewhere < j ? `duplicate of host turn #${elsewhere} (${short(ref.ids[elsewhere])})` : `gap: host turns #${j}..#${elsewhere - 1} missing (${short(ref.ids[j])}..${short(ref.ids[elsewhere - 1])})`;
  return `shown host turn ${best.at}/${pairs.length} breaks at chat host turn #${j} (${short(ref.ids[j])}) of ${ref.pairs.length}: ${what}`;
}

const record = (chat: string, phase: string, problem: string | null, kind = "turns"): void => {
  if (problem !== null) mismatches.push({ chat, phase, kind, detail: problem });
};

const changedBetween = (a: Ref, b: Ref): boolean => a.signature !== b.signature || a.ids.length !== b.ids.length;

/** Steps 1-3 for one chat: the client's full load against the reference, and its "/" list. */
/** The host itself failing a chat (it lost it, or failed loading it): the old reads fail the same; the chat is skipped. */
const hostFailure = (cause: unknown): boolean => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /\b(404 host_chat_missing|502 agent_host_failed)\b/.test(text) || (cause instanceof ApiError && (cause.code === "host_chat_missing" || cause.code === "agent_host_failed"));
};

async function checkChat(machine: string, row: { id?: string; session?: string; status?: string }): Promise<Emu | null> {
  const session = (row.session ?? row.id)!;
  const name = `${short(machine)}/${short(session.split("/").pop())}`;
  for (let attempt = 1; ; attempt++) {
    try { return await checkChatOnce(machine, session, name, row.status); }
    catch (cause) {
      // fixed wait: a host failure is retried once after a pause; there is no event to wait for
      if (attempt < 2) { await sleep(2_000); continue; }
      counts.hostSkipped.push(`${name} ${cause instanceof ApiError ? `${cause.status} ${cause.code}` : (cause as Error).message}`);
      return null;
    }
  }
}

/** One try: throws a host failure (the caller retries it once, then skips the chat). */
async function checkChatOnce(machine: string, session: string, name: string, status: string | undefined): Promise<Emu | null> {
  let phase = "load";
  try {
    const before = await reference(machine, session);
    const emu = new Emu(machine, session, name, () => phase);
    await emu.settle();
    // "/": the follow-ups must have brought the list when the agent has one
    counts.commandsChecked += 1;
    if (before.commands > 0 && (emu.screen?.commands?.length ?? 0) === 0) {
      mismatches.push({ chat: name, phase, kind: "commands-missing", detail: `plain read has ${before.commands} commands, screen has ${emu.screen?.commands?.length ?? "none"} (deferred=${emu.screen?.commands_deferred === true})` });
    }
    phase = "page-back";
    for (let guard = 0; guard < 500 && typeof emu.olderCursor === "string"; guard++) await emu.pageBack();
    const after = await reference(machine, session);
    const volatile = before.busy || after.busy || changedBetween(before, after);
    record(name, phase, compare(emu.shown(), after, before, typeof emu.olderCursor !== "string", volatile));
    counts.turns += after.ids.length;
    counts.maxTurns = Math.max(counts.maxTurns, after.ids.length);
    if (emu.history409 > 0) counts.raceReloads += emu.history409;
    counts.chats += 1;
    counts.referenceBeforeSteps += before.steps;
    counts.maxBytes = Math.max(counts.maxBytes, after.bytes);
    counts.sizes[after.bytes < 100_000 ? "<100KB" : after.bytes < 1_000_000 ? "<1MB" : after.bytes < 10_000_000 ? "<10MB" : ">=10MB"]! += 1;
    counts.statuses[status ?? "?"] = (counts.statuses[status ?? "?"] ?? 0) + 1;
    return emu;
  } catch (cause) {
    if (hostFailure(cause)) throw cause;
    counts.errors += 1;
    mismatches.push({ chat: name, phase, kind: "error", detail: cause instanceof Error ? cause.message.replace(/session=[^&\s)]+/g, "session=…") : String(cause) });
    return null;
  }
}

/** Step 4/5 on one changing chat, for `ms`. */
async function soak(machine: string, session: string, emu: Emu, ms: number): Promise<void> {
  const name = emu.name;
  const end = Date.now() + ms;
  let round = 0;
  let current = emu;
  let phase = "delta";
  while (Date.now() < end) {
    round += 1;
    try {
      // a newest re-read: a known (and anchor) delta against what the client keeps
      phase = "delta";
      const before = await reference(machine, session);
      await current.settle();
      const after = await reference(machine, session);
      const volatile = before.busy || after.busy || changedBetween(before, after);
      record(name, phase, compare(current.shown(), after, before, typeof current.olderCursor !== "string", volatile));
      if (after.commands > 0 && (current.screen?.commands?.length ?? 0) === 0) mismatches.push({ chat: name, phase, kind: "commands-missing", detail: `after a delta read: plain ${after.commands}, screen ${current.screen?.commands?.length ?? "none"}` });
      counts.deltaChecks += 1;

      if (round % 3 === 0) {
        // a reload: what the device kept (flushed on leaving every other time), a fresh memory, stored() then read()
        phase = "reload";
        if (round % 6 === 0) flushHostChat(machine, session);
        setHostReadStore(memoryStore);
        const fresh = new Emu(machine, session, name, () => phase);
        const kept = await fresh.src.stored!();
        if (kept !== null) { fresh.newest = kept; fresh.olderCursor = kept.cursor ?? null; fresh.previous = kept; }
        const refBefore = await reference(machine, session);
        await fresh.settle();
        for (let guard = 0; guard < 500 && typeof fresh.olderCursor === "string"; guard++) await fresh.pageBack();
        const refAfter = await reference(machine, session);
        record(name, phase, compare(fresh.shown(), refAfter, refBefore, typeof fresh.olderCursor !== "string", refBefore.busy || refAfter.busy || changedBetween(refBefore, refAfter)));
        if (refAfter.commands > 0 && (fresh.screen?.commands?.length ?? 0) === 0) mismatches.push({ chat: name, phase, kind: "commands-missing", detail: `after a reload: plain ${refAfter.commands}, screen ${fresh.screen?.commands?.length ?? "none"} (kept=${kept !== null})` });
        counts.reloadChecks += 1;
        current = fresh;
      }

      if (round % 4 === 0) {
        // a race: a first open with nothing kept, paged back one page at a time with newest reads between
        phase = "race";
        setHostReadStore(null);
        const racer = new Emu(machine, session, name, () => phase);
        await racer.settle();
        for (let guard = 0; guard < 500 && typeof racer.olderCursor === "string"; guard++) {
          const outcome = await racer.pageBack();
          if (outcome === "reloaded") counts.raceReloads += 1;
          // fixed wait: lets the working chat move between a page and the next newest read (the race)
          await sleep(500);
          await racer.readNewest();
          const ref = await reference(machine, session);
          record(name, `${phase}:step`, compare(racer.shown(), ref, null, typeof racer.olderCursor !== "string", true));
          counts.raceChecks += 1;
        }
        setHostReadStore(memoryStore);
        current = new Emu(machine, session, name, () => "delta");
        await current.settle();
        for (let guard = 0; guard < 500 && typeof current.olderCursor === "string"; guard++) await current.pageBack();
      }
    } catch (cause) {
      setHostReadStore(memoryStore);
      // fixed wait: the soak's pace between rounds
      if (hostFailure(cause)) { counts.hostSkipped.push(`${name} ${phase} (soak round ${round})`); await sleep(3_000); continue; }
      counts.errors += 1;
      mismatches.push({ chat: name, phase, kind: "error", detail: cause instanceof Error ? cause.message.replace(/session=[^&\s)]+/g, "session=…") : String(cause) });
    }
    // fixed wait: the soak's pace between rounds, so the busy chat changes between two reads
    await sleep(3_000);
  }
}

// ─── run ────────────────────────────────────────────────────────────────────

const started = Date.now();
const busy: { machine: string; session: string; emu: Emu }[] = [];
for (const machine of MACHINES) {
  const response = await globalThis.fetch(`/api/machines/${machine}/host-chats/chats`, REF);
  if (!response.ok) { console.log(`machine ${short(machine)}: chats ${response.status}, skipped`); continue; }
  const rows = ((await response.json()) as { chats: { id?: string; session?: string; status?: string }[] }).chats.slice(0, LIMIT);
  console.log(`machine ${short(machine)}: ${rows.length} chats`);
  const queue = [...rows];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
      const emu = await checkChat(machine, row);
      if (emu !== null && (row.status === "working" || row.status === "asks")) busy.push({ machine, session: (row.session ?? row.id)!, emu });
    }
  }));
  console.log(`  checked; mismatches so far ${mismatches.length}`);
}

if (DELTA_MINUTES > 0) {
  const soaked = busy.slice(0, WORKING);
  console.log(`soak: ${soaked.length} busy chats, ${DELTA_MINUTES} min each`);
  // one at a time: a reload and a race swap the client's store, which every chat shares
  for (const { machine, session, emu } of soaked) await soak(machine, session, emu, DELTA_MINUTES * 60_000);
}

console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), counts, network: stats, mismatches: mismatches.length }, null, 1));
const grouped = new Map<string, Mismatch[]>();
for (const m of mismatches) grouped.set(`${m.kind} ${m.phase}`, [...(grouped.get(`${m.kind} ${m.phase}`) ?? []), m]);
for (const [key, list] of grouped) {
  console.log(`${key}: ${list.length}`);
  for (const m of list.slice(0, 8)) console.log(`  ${m.chat}: ${m.detail}`);
}
process.exit(mismatches.length > 0 ? 1 : 0);
