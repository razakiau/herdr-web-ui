/**
 * Chat groups (ZAC-265): the server's one SQLite file, `groups.sqlite` in the state dir. It keeps
 * the groups, every bridge's hand-off links, the chats the owner placed or removed by hand
 * (`decided`), and the cached chat summaries and digests.
 *
 * Filing (addLinks): the server sends every link it knows on each poll, so filing runs over all
 * of them each time and must change nothing on a repeat. A link files its `to` chat unless that
 * chat is already in a group or in `decided`: what the owner set by hand wins, for good.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { HostArtifact, HostLink, LinkKind } from "../shared/host-chats.ts";
import type { ChatGroup, ChatSummary, DigestEffort, DigestItem, GroupDigest, GroupMember, GroupsAnswer } from "../shared/groups.ts";

/** A group's name when its first chat's title is not known. */
export const UNNAMED_GROUP = "Chat group";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (group_id INTEGER NOT NULL, pc TEXT NOT NULL, session TEXT NOT NULL, joined TEXT NOT NULL, added_at TEXT NOT NULL, UNIQUE (pc, session));
CREATE INDEX IF NOT EXISTS members_group ON members (group_id);
CREATE TABLE IF NOT EXISTS links (pc TEXT NOT NULL, from_session TEXT NOT NULL, to_session TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (pc, from_session, to_session));
CREATE TABLE IF NOT EXISTS decided (pc TEXT NOT NULL, session TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (pc, session));
CREATE TABLE IF NOT EXISTS chat_summaries (pc TEXT NOT NULL, session TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '', cost REAL, last_call_seen TEXT, written_at TEXT NOT NULL, PRIMARY KEY (pc, session));
CREATE TABLE IF NOT EXISTS digests (group_id INTEGER PRIMARY KEY, text TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, cost REAL, written_at TEXT NOT NULL, chats_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS digest_spend (group_id INTEGER PRIMARY KEY, usd REAL NOT NULL, unpriced INTEGER NOT NULL DEFAULT 0);
`;

type MemberRow = { group_id: number; pc: string; session: string; joined: "link" | "manual"; added_at: string };
type DigestBody = Pick<GroupDigest, "direction" | "open" | "done" | "perChat">;

export class GroupStore {
  private readonly db: Database;

  constructor(stateDir: string) {
    this.db = new Database(join(stateDir, "groups.sqlite"), { create: true });
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec(SCHEMA);
    // a summary keeps the chat's artifacts it was written with: the group pass links its items to them (Task 8)
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(chat_summaries)").all().map((column) => column.name);
    if (!columns.includes("artifacts")) this.db.exec("ALTER TABLE chat_summaries ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'");
    const spend = this.db.query<{ name: string }, []>("PRAGMA table_info(digest_spend)").all().map((column) => column.name);
    if (!spend.includes("unpriced")) this.db.exec("ALTER TABLE digest_spend ADD COLUMN unpriced INTEGER NOT NULL DEFAULT 0");
  }

  close(): void { this.db.close(); }

  /** Store `links` (deduplicated on pc, from, to; the first seen wins) and file each `to` chat; `filed` counts the chats placed. */
  addLinks(pc: string, links: HostLink[], titles: Map<string, string> = new Map()): { filed: number } {
    const insert = this.db.query("INSERT OR IGNORE INTO links (pc, from_session, to_session, kind, at) VALUES (?, ?, ?, ?, ?)");
    let filed = 0;
    this.db.transaction(() => {
      // oldest first, so a chain is filed from its start whatever order the bridge answered in
      for (const link of [...links].sort((a, b) => a.at.localeCompare(b.at))) {
        if (link.from === link.to) continue;
        insert.run(pc, link.from, link.to, link.kind, link.at);
        if (this.groupOf(pc, link.to) !== null || this.isDecided(pc, link.to)) continue;
        const now = new Date().toISOString();
        let group = this.groupOf(pc, link.from);
        if (group === null) {
          // `from` was taken out by hand: it is not filed again, so its continuation has no group to join
          if (this.isDecided(pc, link.from)) continue;
          group = this.insertGroup(titles.get(link.from) || UNNAMED_GROUP, now);
          this.putMember(group, pc, link.from, "link", now);
        }
        this.putMember(group, pc, link.to, "link", now);
        this.touch(group, now);
        filed += 1;
      }
    })();
    return { filed };
  }

  /** VS Code forks name their source (`fork_of`): each is a `fork` link from it. */
  addForks(pc: string, rows: { session: string; fork_of?: string; title: string }[]): { filed: number } {
    const titles = new Map(rows.map((row) => [row.session, row.title]));
    const at = new Date().toISOString();
    const links = rows.flatMap((row): HostLink[] => row.fork_of ? [{ from: row.fork_of, to: row.session, kind: "fork" satisfies LinkKind, at }] : []);
    return this.addLinks(pc, links, titles);
  }

  /** Put a chat in a group by hand (moving it if it was in another). */
  add(groupId: number, pc: string, session: string): void { this.move(groupId, pc, session); }

  move(groupId: number, pc: string, session: string): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      const before = this.groupOf(pc, session);
      this.putMember(groupId, pc, session, "manual", now);
      this.decide(pc, session, now);
      this.touch(groupId, now);
      if (before !== null && before !== groupId) this.touch(before, now);
    })();
  }

  remove(pc: string, session: string): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      const before = this.groupOf(pc, session);
      this.db.query("DELETE FROM members WHERE pc = ? AND session = ?").run(pc, session);
      this.decide(pc, session, now);
      if (before !== null) this.touch(before, now);
    })();
  }

  create(name: string, first?: { pc: string; session: string }): number {
    return this.db.transaction(() => {
      const id = this.insertGroup(name, new Date().toISOString());
      if (first) this.move(id, first.pc, first.session);
      return id;
    })();
  }

  rename(id: number, name: string): void {
    this.db.query("UPDATE groups SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id);
  }

  /** Delete a group: its chats are only ungrouped, and links never file them again. */
  delete(id: number): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const member of this.membersOf(id)) this.decide(member.pc, member.session, now);
      this.db.query("DELETE FROM members WHERE group_id = ?").run(id);
      this.db.query("DELETE FROM digests WHERE group_id = ?").run(id);
      this.db.query("DELETE FROM digest_spend WHERE group_id = ?").run(id);
      this.db.query("DELETE FROM groups WHERE id = ?").run(id);
    })();
  }

  /**
   * Merge a group into another (owner, round 10): every member moves to `into`, each recorded as a
   * hand decision (`decided`) so no link files it back, and the source group goes with its digest
   * and spend. Throws when either group does not exist or they are the same.
   */
  merge(source: number, into: number): void {
    this.db.transaction(() => {
      if (source === into) throw new Error("a group cannot merge into itself");
      const exists = this.db.query<{ id: number }, [number]>("SELECT id FROM groups WHERE id = ?");
      if (exists.get(source) === null || exists.get(into) === null) throw new Error("no such group");
      const now = new Date().toISOString();
      for (const member of this.membersOf(source)) this.decide(member.pc, member.session, now);
      // each keeps how it joined and when, so the target's tree still follows its links
      this.db.query("UPDATE members SET group_id = ? WHERE group_id = ?").run(into, source);
      this.db.query("DELETE FROM digests WHERE group_id = ?").run(source);
      this.db.query("DELETE FROM digest_spend WHERE group_id = ?").run(source);
      this.db.query("DELETE FROM groups WHERE id = ?").run(source);
      this.touch(into, now);
    })();
  }

  /**
   * Move the chat, and every member its links lead to (forward, inside the group), to a new group
   * named as the old one. Members placed by hand stay. Throws when the chat is in no group.
   */
  split(pc: string, session: string): number {
    return this.db.transaction(() => {
      const old = this.groupOf(pc, session);
      if (old === null) throw new Error(`${pc} ${session} is in no group`);
      const members = new Map(this.membersOf(old).filter((member) => member.pc === pc).map((member) => [member.session, member]));
      const next = this.db.query<{ to_session: string }, [string, string]>("SELECT to_session FROM links WHERE pc = ? AND from_session = ?");
      const moving = new Set([session]);
      const queue = [session];
      while (queue.length > 0) {
        for (const { to_session: to } of next.all(pc, queue.shift()!)) {
          if (moving.has(to) || members.get(to)?.joined !== "link") continue;
          moving.add(to);
          queue.push(to);
        }
      }
      const now = new Date().toISOString();
      const name = this.db.query<{ name: string }, [number]>("SELECT name FROM groups WHERE id = ?").get(old)!.name;
      const id = this.insertGroup(name, now);
      const update = this.db.query("UPDATE members SET group_id = ? WHERE pc = ? AND session = ?");
      for (const chat of moving) update.run(id, pc, chat);
      this.touch(old, now);
      return id;
    })();
  }

  snapshot(): Omit<GroupsAnswer, "digestDefaults" | "digests"> & { digests: GroupDigest[] } {
    const members = new Map<number, GroupMember[]>();
    for (const row of this.db.query<MemberRow, []>("SELECT * FROM members ORDER BY added_at, rowid").all()) {
      const list = members.get(row.group_id) ?? [];
      list.push({ pc: row.pc, session: row.session, joined: row.joined, addedAt: row.added_at });
      members.set(row.group_id, list);
    }
    const groups: ChatGroup[] = this.db.query<{ id: number; name: string; created_at: string; updated_at: string }, []>("SELECT * FROM groups ORDER BY id").all()
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, members: members.get(row.id) ?? [] }));
    const links = this.db.query<{ pc: string; from_session: string; to_session: string; kind: LinkKind; at: string }, []>("SELECT * FROM links ORDER BY at, rowid").all()
      .map((row) => ({ pc: row.pc, from: row.from_session, to: row.to_session, kind: row.kind, at: row.at }));
    const summaries: ChatSummary[] = this.db.query<{ pc: string; session: string; text: string; model: string; last_call_seen: string | null; written_at: string }, []>("SELECT * FROM chat_summaries ORDER BY pc, session").all()
      .map((row) => ({ pc: row.pc, session: row.session, text: row.text, lastCallSeen: row.last_call_seen, model: row.model, writtenAt: row.written_at }));
    const digests: GroupDigest[] = this.db.query<{ group_id: number; text: string; model: string; effort: string; cost: number | null; written_at: string; chats_seen: string }, []>("SELECT * FROM digests ORDER BY group_id").all()
      .map((row) => ({ groupId: row.group_id, ...digestBody(row.text), model: row.model, effort: digestEffort(row.effort), costUsd: row.cost ?? 0, writtenAt: row.written_at, chatsSeen: parseKeys(row.chats_seen) }));
    return { groups, links, summaries, digests };
  }

  /** A chat's summary, replaced; `effort`, `cost` and `artifacts` as it was written (Task 8). */
  setSummary(summary: ChatSummary, extra: { effort?: string; costUsd?: number | null; artifacts?: HostArtifact[] } = {}): void {
    this.db.query("INSERT OR REPLACE INTO chat_summaries (pc, session, text, model, effort, cost, last_call_seen, written_at, artifacts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(summary.pc, summary.session, summary.text, summary.model, extra.effort ?? "", extra.costUsd ?? null, summary.lastCallSeen, summary.writtenAt, JSON.stringify(extra.artifacts ?? []));
  }

  /** One chat's summary and the artifacts it was written with; null when it has none. */
  summary(pc: string, session: string): (ChatSummary & { artifacts: HostArtifact[] }) | null {
    const row = this.db.query<{ text: string; model: string; last_call_seen: string | null; written_at: string; artifacts: string }, [string, string]>(
      "SELECT text, model, last_call_seen, written_at, artifacts FROM chat_summaries WHERE pc = ? AND session = ?").get(pc, session);
    if (!row) return null;
    let artifacts: HostArtifact[] = [];
    try { const value: unknown = JSON.parse(row.artifacts); if (Array.isArray(value)) artifacts = value as HostArtifact[]; } catch { artifacts = []; }
    return { pc, session, text: row.text, model: row.model, lastCallSeen: row.last_call_seen, writtenAt: row.written_at, artifacts };
  }

  /** A group's digest; null when it has none. */
  digest(groupId: number): GroupDigest | null {
    return this.snapshot().digests.find((each) => each.groupId === groupId) ?? null;
  }

  /** What a group's digest calls have cost, every call counted, a failed run's too (spec §3 Honesty). */
  spent(groupId: number): number {
    return this.db.query<{ usd: number }, [number]>("SELECT usd FROM digest_spend WHERE group_id = ?").get(groupId)?.usd ?? 0;
  }

  /** One call's cost; null when its model has no price: the spend is then a floor (spendIncomplete). */
  addSpent(groupId: number, usd: number | null): void {
    // a group merged or deleted while its digest was written: no row for an id that is gone
    if (!this.hasGroup(groupId)) return;
    if (usd === null) {
      this.db.query("INSERT INTO digest_spend (group_id, usd, unpriced) VALUES (?, 0, 1) ON CONFLICT (group_id) DO UPDATE SET unpriced = unpriced + 1").run(groupId);
      return;
    }
    if (!(usd > 0)) return;
    this.db.query("INSERT INTO digest_spend (group_id, usd) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET usd = usd + excluded.usd").run(groupId, usd);
  }

  /** Whether some digest call of the group had no price: `spent` leaves it out. */
  spendIncomplete(groupId: number): boolean {
    return (this.db.query<{ unpriced: number }, [number]>("SELECT unpriced FROM digest_spend WHERE group_id = ?").get(groupId)?.unpriced ?? 0) > 0;
  }

  /** One digest per group, replaced. */
  setDigest(digest: GroupDigest): void {
    if (!this.hasGroup(digest.groupId)) return;
    const body: DigestBody = { direction: digest.direction, open: digest.open, done: digest.done, perChat: digest.perChat };
    this.db.query("INSERT OR REPLACE INTO digests (group_id, text, model, effort, cost, written_at, chats_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(digest.groupId, JSON.stringify(body), digest.model, digest.effort, digest.costUsd, digest.writtenAt, JSON.stringify(digest.chatsSeen));
  }

  private hasGroup(id: number): boolean {
    return this.db.query("SELECT 1 FROM groups WHERE id = ?").get(id) !== null;
  }

  getSetting(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  private groupOf(pc: string, session: string): number | null {
    return this.db.query<{ group_id: number }, [string, string]>("SELECT group_id FROM members WHERE pc = ? AND session = ?").get(pc, session)?.group_id ?? null;
  }

  private isDecided(pc: string, session: string): boolean {
    return this.db.query("SELECT 1 FROM decided WHERE pc = ? AND session = ?").get(pc, session) !== null;
  }

  private decide(pc: string, session: string, at: string): void {
    this.db.query("INSERT OR REPLACE INTO decided (pc, session, at) VALUES (?, ?, ?)").run(pc, session, at);
  }

  private membersOf(groupId: number): MemberRow[] {
    return this.db.query<MemberRow, [number]>("SELECT * FROM members WHERE group_id = ?").all(groupId);
  }

  private insertGroup(name: string, now: string): number {
    return Number(this.db.query("INSERT INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, now, now).lastInsertRowid);
  }

  /** Insert or re-place a member; a chat stays in at most one group (UNIQUE (pc, session)). */
  private putMember(groupId: number, pc: string, session: string, joined: "link" | "manual", now: string): void {
    this.db.query("INSERT INTO members (group_id, pc, session, joined, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pc, session) DO UPDATE SET group_id = excluded.group_id, joined = excluded.joined, added_at = excluded.added_at")
      .run(groupId, pc, session, joined, now);
  }

  private touch(groupId: number, now: string): void {
    this.db.query("UPDATE groups SET updated_at = ? WHERE id = ?").run(now, groupId);
  }
}

function digestBody(text: string): DigestBody {
  try {
    const value = JSON.parse(text) as Partial<DigestBody>;
    const items = (list: unknown): DigestItem[] => Array.isArray(list) ? list as DigestItem[] : [];
    return { direction: typeof value.direction === "string" ? value.direction : "", open: items(value.open), done: items(value.done), perChat: Array.isArray(value.perChat) ? value.perChat : [] };
  } catch { return { direction: "", open: [], done: [], perChat: [] }; }
}

/** The digest's effort as stored; anything else reads as the default, low. */
function digestEffort(text: string): DigestEffort {
  return text === "medium" || text === "high" ? text : "low";
}

/** The chats a digest saw: a list of `pc session` keys (an early row kept them as a record's keys). */
function parseKeys(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value.filter((each): each is string => typeof each === "string");
    return typeof value === "object" && value !== null ? Object.keys(value) : [];
  } catch { return []; }
}
