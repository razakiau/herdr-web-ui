/**
 * The questions an agent asks without stopping its turn (`ask_user_async`, ZAC-326). The bridge
 * holds them in one JSON file, written whole (temp + rename) on every change, so a restart keeps
 * them. An optional question with a recommended option is "due" once nobody has had Ovis open for
 * AWAY_AFTER_MS: the caller may then answer it with the recommendation, marked as assumed.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AskKind = "optional" | "blocking";

export interface AsyncQuestion {
  /** "ask-" + 8 hex */
  id: string;
  /** the chat's row id (HostChatRow.session) */
  session: string;
  question: string;
  options: { label: string; description?: string }[];
  /** 0-based index into options, null when none */
  recommended: number | null;
  kind: AskKind;
  /** epoch ms */
  askedAt: number;
  answer: { label: string; assumed: boolean; at: number } | null;
}

export const AWAY_AFTER_MS = 60_000;
/** answered questions stay this long (the transcript shows them), then go on the next load */
const KEEP_ANSWERED_MS = 7 * 24 * 60 * 60_000;

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

/** Whether `recommended` is null or the index of one of `count` options. */
const recommendedFits = (recommended: unknown, count: number): recommended is number | null =>
  recommended === null || (Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < count);

/** A stored question, or null for anything else the file holds. */
function questionOf(value: unknown): AsyncQuestion | null {
  const row = record(value);
  if (!row) return null;
  const { id, session, question, options, recommended, kind, askedAt, answer } = row;
  if (typeof id !== "string" || typeof session !== "string" || typeof question !== "string" || typeof askedAt !== "number") return null;
  if (kind !== "optional" && kind !== "blocking") return null;
  if (!Array.isArray(options) || !recommendedFits(recommended, options.length)) return null;
  const opts: AsyncQuestion["options"] = [];
  for (const option of options) {
    const o = record(option);
    if (!o || typeof o["label"] !== "string") return null;
    opts.push(typeof o["description"] === "string" ? { label: o["label"], description: o["description"] } : { label: o["label"] });
  }
  let given: AsyncQuestion["answer"] = null;
  if (answer !== null) {
    const a = record(answer);
    if (!a || typeof a["label"] !== "string" || typeof a["assumed"] !== "boolean" || typeof a["at"] !== "number") return null;
    given = { label: a["label"], assumed: a["assumed"], at: a["at"] };
  }
  return { id, session, question, options: opts, recommended, kind, askedAt, answer: given };
}

/** callers get copies, so nothing they change reaches the store unsaved */
const copy = (q: AsyncQuestion): AsyncQuestion => structuredClone(q);

export class AsyncAskStore {
  private readonly questions = new Map<string, AsyncQuestion>();
  /**
   * Starting state: not in use, last seen now. A restarted bridge cannot know when a page last had
   * Ovis open, so a question asked long ago becomes due AWAY_AFTER_MS after the start, not at once.
   */
  private inUse = false;
  private lastInUseAt: number;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.lastInUseAt = now();
    this.load();
  }

  /** Throws unless `recommended` is null or the index of one of `options`. */
  add(q: Omit<AsyncQuestion, "id" | "askedAt" | "answer">): AsyncQuestion {
    if (!recommendedFits(q.recommended, q.options.length)) throw new Error(`recommended must be null or an option index below ${q.options.length}`);
    let id: string;
    do id = `ask-${randomBytes(4).toString("hex")}`; while (this.questions.has(id));
    const stored: AsyncQuestion = { ...q, options: q.options.map((o) => ({ ...o })), id, askedAt: this.now(), answer: null };
    this.questions.set(id, stored);
    this.save();
    return copy(stored);
  }

  /** The session's unanswered questions, oldest first. */
  pending(session: string): AsyncQuestion[] {
    return [...this.questions.values()].filter((q) => q.session === session && !q.answer).sort((a, b) => a.askedAt - b.askedAt).map(copy);
  }

  get(id: string): AsyncQuestion | null {
    const q = this.questions.get(id);
    return q ? copy(q) : null;
  }

  /** Null when the question is unknown or already answered: a question is answered once. */
  answer(id: string, label: string, assumed: boolean): AsyncQuestion | null {
    const q = this.questions.get(id);
    if (!q || q.answer) return null;
    q.answer = { label, assumed, at: this.now() };
    this.save();
    return copy(q);
  }

  /**
   * The user's correction of an answer the bridge assumed for them (the transcript's Change): the
   * user's label replaces it, no longer assumed, so a second correction finds nothing to correct.
   * `previous` is the assumed answer, for `revert` when the correction never reaches the chat.
   * Null when the question is unknown, unanswered, or already answered by the user.
   */
  correct(id: string, label: string): { question: AsyncQuestion; previous: NonNullable<AsyncQuestion["answer"]> } | null {
    const q = this.questions.get(id);
    if (!q?.answer?.assumed) return null;
    const previous = q.answer;
    q.answer = { label, assumed: false, at: this.now() };
    this.save();
    return { question: copy(q), previous: { ...previous } };
  }

  /** Puts back the answer a correction replaced (`correct`'s `previous`): one that failed to send. */
  revert(id: string, previous: NonNullable<AsyncQuestion["answer"]>): void {
    const q = this.questions.get(id);
    if (!q) return;
    q.answer = { ...previous };
    this.save();
  }

  /**
   * Clears the answer of a question that has one (an answer recorded but never delivered to the
   * chat): it is pending again. False when the id is unknown.
   */
  reopen(id: string): boolean {
    const q = this.questions.get(id);
    if (!q) return false;
    if (q.answer) { q.answer = null; this.save(); }
    return true;
  }

  /** Whether some page has Ovis open; going from in use to not records when it closed. */
  setInUse(inUse: boolean): void {
    if (this.inUse && !inUse) this.lastInUseAt = this.now();
    this.inUse = inUse;
  }

  /** Optional questions with a recommendation, unanswered, whose user has been away AWAY_AFTER_MS. */
  due(): AsyncQuestion[] {
    if (this.inUse) return [];
    const now = this.now();
    return [...this.questions.values()]
      .filter((q) => q.kind === "optional" && q.recommended !== null && !q.answer && now - Math.max(q.askedAt, this.lastInUseAt) >= AWAY_AFTER_MS)
      .sort((a, b) => a.askedAt - b.askedAt)
      .map(copy);
  }

  private load(): void {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!Array.isArray(parsed)) return;
    const now = this.now();
    for (const value of parsed) {
      const q = questionOf(value);
      if (q && !(q.answer && now - q.answer.at > KEEP_ANSWERED_MS)) this.questions.set(q.id, q);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.questions.values()]), { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, this.file);
  }
}
