/**
 * Slims the pictures out of old Copilot chat records (ZAC-337, the "prevent" half).
 *
 * Why: VS Code's agent host sends a chat's snapshot as one WebSocket message, and Bun's client
 * (1.4.2) refuses a message over 128 MB, which drops the bridge's whole connection. A chat grows
 * past that mostly from pictures: every `session.binary_asset` event in
 * `$COPILOT_HOME/session-state/<uuid>/events.jsonl` carries its picture as base64 in `data.data`.
 * Seen: a 242 MB record, 119 MB of it 676 pictures, of which the agent still saw 14.
 *
 * What the agent still sees (proven with a fake model on Copilot CLI 1.0.105, ZAC-337): after a
 * compaction the CLI rebuilds the conversation from the summary on, so the cut is the latest
 * `session.compaction_start` before the LAST `session.compaction_complete`. A picture before the
 * cut is no longer sent to the model, unless an event at or after the cut names its `assetId`:
 * assets are deduplicated by content hash (`sha256:<hex>`), and a later tool result points back at
 * an old one through `binaryResultsForLlm[].assetId`. So a picture before the cut that nothing at
 * or after the cut names is blanked to a 1x1 PNG, keeping its `assetId`, `id`, `timestamp` and
 * `description`; anything else is left as it is, and a record without a compaction is not touched.
 *
 * `model.messages_snapshot` and `model.model_call_success` (written after a manual `/compact`) can
 * carry request messages too. Measured on one Mac's 381 records (2026-11-16): none of those events
 * held an inline picture (all `model.*` events of a 270 MB record together are 0.1 MB), so they are
 * left alone: blanking inside them is unproven and would buy nothing seen so far.
 *
 * This prevents the NEXT load from being too big; it does not fix a chat the host already holds:
 * the agent host only re-reads a record after it restarts or evicts the chat.
 *
 * Safety: only idle records (not written for `IDLE_MS`), so a sweep never races the CLI's appends
 * (the CLI opens the record per write: `lsof` showed no running copilot-runtime holding one open).
 * The original is first copied to `$COPILOT_HOME/session-state-backups/<uuid>-events-<date>.jsonl`;
 * the new record is streamed line by line into a temp file beside it (records pass 250 MB: never
 * read whole; two passes), and renamed over the original only if the original's size and mtime did
 * not change meanwhile. A line that does not parse is copied as it is.
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultCopilotHome } from "../copilot.ts";

/** a 1x1 PNG (68 bytes): what a blanked picture becomes */
export const BLANK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const BLANK_BYTES = 68;
/**
 * Records below this are left alone: half of the 128 MB message cap, as a snapshot came out at
 * about 0.85 x its record (observed), so a 64 MB record is still well under the cap.
 */
export const THRESHOLD_BYTES = 64 * 1024 * 1024;
/** a record written in the last 30 minutes may still be in use: it waits until it rests */
export const IDLE_MS = 30 * 60_000;
export const SWEEP_EVERY_MS = 60 * 60_000;
/** a backup this sweep wrote is deleted after 14 days (by mtime): the Mac's disk has filled before */
export const BACKUP_KEEP_MS = 14 * 24 * 60 * 60_000;
/** the first sweep waits a minute, so it does not compete with the bridge's own start */
const FIRST_SWEEP_MS = 60_000;
/** `HERDR_WEB_SLIM_RECORDS=off` turns the sweep off */
export const KILL_SWITCH = "HERDR_WEB_SLIM_RECORDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** the name `slimRecord` gives a backup; hand-made ones (`9585e1b9-events-<date>.jsonl`) do not match */
const SWEEP_BACKUP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-events-\d{4}-\d{2}-\d{2}\.jsonl$/i;
const REF_MARK = Buffer.from("sha256:");
const REF_LENGTH = "sha256:".length + 64;
const ASSET_REF = /^sha256:[0-9a-f]{64}$/;
const HEAD_BYTES = 4096;
const TYPE_PREFIX = /^\{"type":"([^"\\]+)"/;
const ASSET_ID = /^\{"type":"session\.binary_asset","data":\{[^{}]*?"assetId":"(sha256:[0-9a-f]{64})"/;
const MIME_TYPE = /^\{"type":"session\.binary_asset","data":\{[^{}]*?"mimeType":"([^"\\]*)"/;
const BLANK_DATA = Buffer.from(`"data":"${BLANK_PNG}"`);
const NL = Buffer.from("\n");
const ASSET_PREFIX = Buffer.from(`{"type":"session.binary_asset","data":{`);
const DATA_VALUE = Buffer.from(`"data":"`);
const QUOTE = 0x22;
const MIME_FIELD = /"mimeType":"[^"\\]*"/g;
const LENGTH_FIELD = /"byteLength":\d+/g;
const NEWLINE = 0x0a;

export type SlimResult =
  | { status: "slimmed"; beforeBytes: number; afterBytes: number; blanked: number; kept: number; backup: string }
  | { status: "untouched"; reason: "no-compaction" | "nothing-to-blank"; kept: number }
  | { status: "skipped"; reason: "disk-space" }
  | { status: "aborted"; reason: "changed" };

interface Line { bytes: Buffer; newline: boolean }

/** The record's lines as they are on disk, each without its `\n` (`newline` says it had one). */
async function* lines(path: string): AsyncGenerator<Line> {
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, at);
      yield { bytes: pending.length ? Buffer.concat([...pending, piece]) : piece, newline: true };
      pending = [];
      start = at + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  if (pending.length) yield { bytes: Buffer.concat(pending), newline: false };
}

/** Every `sha256:<hex>` the line names, found in its bytes (a picture's base64 is never decoded). */
function* assetRefs(bytes: Buffer): Generator<string> {
  for (let at = bytes.indexOf(REF_MARK); at !== -1; at = bytes.indexOf(REF_MARK, at + REF_MARK.length)) {
    const ref = bytes.toString("latin1", at, at + REF_LENGTH);
    if (ASSET_REF.test(ref)) yield ref;
  }
}

function parsed(bytes: Buffer): { type?: unknown; data?: { assetId?: unknown; mimeType?: unknown; data?: unknown } } | null {
  try { return JSON.parse(bytes.toString("utf8")) as never; } catch { return null; }
}

/**
 * What the first pass needs of a line, read from its head where the CLI writes it (`type` first,
 * then `data` with `assetId` and `mimeType` before the picture); parsed whole only when the head
 * does not say. Decoding each picture as a string doubled the sweep's memory (measured).
 */
function readLine(bytes: Buffer): { type: string | null; picture?: string } {
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, HEAD_BYTES));
  const type = TYPE_PREFIX.exec(head)?.[1] ?? null;
  const event = type === null ? parsed(bytes) : null;
  const kind = type ?? (typeof event?.type === "string" ? event.type : null);
  if (kind !== "session.binary_asset") return { type: kind };
  const assetId = ASSET_ID.exec(head)?.[1], mimeType = MIME_TYPE.exec(head)?.[1];
  if (assetId && mimeType) return { type: kind, ...(mimeType.startsWith("image/") && !bytes.includes(BLANK_DATA) ? { picture: assetId } : {}) };
  const data = (event ?? parsed(bytes))?.data;
  if (typeof data?.assetId !== "string" || typeof data.mimeType !== "string" || !data.mimeType.startsWith("image/") || data.data === BLANK_PNG) return { type: kind };
  return { type: kind, picture: data.assetId };
}

/** The first pass: which lines to blank, and how many pictures stay. */
async function plan(path: string): Promise<{ lineCount: number; blank: Set<number>; kept: number; compacted: boolean }> {
  const starts: number[] = [];
  let lastComplete = -1;
  const pictures: { line: number; assetId: string }[] = [];
  /** the last line that names each asset, its own `session.binary_asset` included */
  const lastNamed = new Map<string, number>();
  let index = 0;
  for await (const { bytes } of lines(path)) {
    const { type, picture } = readLine(bytes);
    if (type === "session.compaction_start") starts.push(index);
    else if (type === "session.compaction_complete") lastComplete = index;
    else if (picture) pictures.push({ line: index, assetId: picture });
    for (const ref of assetRefs(bytes)) lastNamed.set(ref, index);
    index++;
  }
  const cut = Math.max(-1, ...starts.filter((start) => start < lastComplete));
  if (cut < 0) return { lineCount: index, blank: new Set(), kept: pictures.length, compacted: false };
  const blank = new Set(pictures.filter((picture) => picture.line < cut && (lastNamed.get(picture.assetId) ?? -1) < cut).map((picture) => picture.line));
  return { lineCount: index, blank, kept: pictures.length - blank.size, compacted: true };
}

function blankedByParse(bytes: Buffer): Buffer {
  const event = JSON.parse(bytes.toString("utf8")) as { data: Record<string, unknown> };
  event.data = { ...event.data, mimeType: "image/png", byteLength: BLANK_BYTES, data: BLANK_PNG };
  return Buffer.from(JSON.stringify(event));
}

/**
 * The line with its picture swapped for the blank one. Done in the bytes where the CLI's layout
 * allows (the picture is never decoded: parsing hundreds of them held 180 MB, measured), checked
 * by parsing the short result; any other line is parsed whole.
 */
function blanked(bytes: Buffer): Buffer {
  const start = bytes.indexOf(DATA_VALUE, ASSET_PREFIX.length);
  const end = start === -1 ? -1 : bytes.indexOf(QUOTE, start + DATA_VALUE.length);
  if (bytes.subarray(0, ASSET_PREFIX.length).equals(ASSET_PREFIX) && end !== -1) {
    const before = bytes.toString("utf8", 0, start);
    if ((before.match(MIME_FIELD) ?? []).length === 1 && (before.match(LENGTH_FIELD) ?? []).length === 1) {
      const line = Buffer.concat([
        Buffer.from(before.replace(MIME_FIELD, `"mimeType":"image/png"`).replace(LENGTH_FIELD, `"byteLength":${BLANK_BYTES}`)),
        DATA_VALUE, Buffer.from(BLANK_PNG), bytes.subarray(end),
      ]);
      try {
        const data = (JSON.parse(line.toString("utf8")) as { data?: Record<string, unknown> }).data;
        if (data?.data === BLANK_PNG && data.mimeType === "image/png" && data.byteLength === BLANK_BYTES) return line;
      } catch { /* not the layout it looked like */ }
    }
  }
  return blankedByParse(bytes);
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function freeBytesOf(dir: string): number {
  const fs = statfsSync(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}

export interface SlimOptions {
  /** the chat's uuid, for the backup's name */
  id: string;
  backupDir: string;
  now?: Date;
  /** Tests: the free bytes where the record lives. */
  freeBytes?: (dir: string) => number;
  /** Tests: runs once the temp file is written, before the original is checked and replaced. */
  beforeRename?: () => void;
}

/** Blanks one record's pictures the agent no longer sees (see the top of this file). */
export async function slimRecord(path: string, options: SlimOptions): Promise<SlimResult> {
  const before = statSync(path);
  const { lineCount, blank, kept, compacted } = await plan(path);
  if (!compacted) return { status: "untouched", reason: "no-compaction", kept };
  if (blank.size === 0) return { status: "untouched", reason: "nothing-to-blank", kept };
  const dir = dirname(path);
  // the backup and the temp file can each take the record's size
  if ((options.freeBytes ?? freeBytesOf)(dir) < 2 * before.size) return { status: "skipped", reason: "disk-space" };

  mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
  const backup = join(options.backupDir, `${options.id}-events-${localDate(options.now ?? new Date())}.jsonl`);
  if (!existsSync(backup)) {
    // copied under another name first: a backup that exists is a whole one
    const partial = `${backup}.${process.pid}.tmp`;
    copyFileSync(path, partial);
    // dated now whatever the copy kept (a clone can keep the record's mtime): its 14 days start here
    const written = new Date();
    utimesSync(partial, written, written);
    renameSync(partial, backup);
  }

  const temp = join(dir, `events.jsonl.slim-${process.pid}.tmp`);
  const out = await open(temp, "wx", before.mode & 0o777);
  let replaced = false;
  try {
    let batch: Buffer[] = [];
    let batched = 0;
    const flush = async () => { if (batched) await out.write(Buffer.concat(batch)); batch = []; batched = 0; };
    let index = 0;
    for await (const { bytes, newline } of lines(path)) {
      const piece = blank.has(index) ? blanked(bytes) : bytes;
      batch.push(piece);
      if (newline) batch.push(NL);
      batched += piece.length + (newline ? 1 : 0);
      if (batched >= 4 << 20) await flush();
      index++;
    }
    await flush();
    await out.sync();
    await out.close();
    options.beforeRename?.();
    const now = statSync(path);
    if (index !== lineCount || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ino !== before.ino) return { status: "aborted", reason: "changed" };
    renameSync(temp, path);
    replaced = true;
    return { status: "slimmed", beforeBytes: before.size, afterBytes: statSync(path).size, blanked: blank.size, kept, backup };
  } finally {
    await out.close().catch(() => {});
    if (!replaced) try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

export interface SweepOptions {
  home?: string;
  thresholdBytes?: number;
  idleMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  freeBytes?: (dir: string) => number;
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** Deletes the backups this sweep wrote that are older than `BACKUP_KEEP_MS`; nothing else in the folder. */
export function pruneBackups(backupDir: string, now: Date, log: (line: string) => void): string[] {
  let names: string[];
  try { names = readdirSync(backupDir).filter((name) => SWEEP_BACKUP.test(name)); } catch { return []; }
  const deleted: string[] = [];
  for (const name of names) {
    const path = join(backupDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || now.getTime() - stat.mtimeMs <= BACKUP_KEEP_MS) continue;
      unlinkSync(path);
      deleted.push(name);
      log(`[slim-records] deleted backup ${name} (${mb(stat.size)} MB)`);
    } catch (error) {
      log(`[slim-records] backup ${name}: delete failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
    }
  }
  return deleted;
}

/**
 * One sweep over this machine's records: old backups of earlier sweeps go first, then the big,
 * idle records are slimmed one after another.
 */
export async function sweepRecords(options: SweepOptions = {}): Promise<{ id: string; result: SlimResult }[]> {
  const home = options.home ?? defaultCopilotHome();
  const root = join(home, "session-state");
  const backupDir = join(home, "session-state-backups");
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now?.() ?? new Date();
  pruneBackups(backupDir, now, log);
  let ids: string[];
  try { ids = readdirSync(root).filter((name) => UUID.test(name)); } catch { return []; }
  const results: { id: string; result: SlimResult }[] = [];
  for (const id of ids) {
    const path = join(root, id, "events.jsonl");
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile() || stat.size < (options.thresholdBytes ?? THRESHOLD_BYTES) || now.getTime() - stat.mtimeMs < (options.idleMs ?? IDLE_MS)) continue;
    try {
      const result = await slimRecord(path, { id, backupDir, now, freeBytes: options.freeBytes });
      results.push({ id, result });
      // the uuid and sizes only: nothing of the chat's content
      if (result.status === "slimmed") log(`[slim-records] ${id}: ${mb(result.beforeBytes)} MB -> ${mb(result.afterBytes)} MB, ${result.blanked} pictures blanked, ${result.kept} kept`);
      else if (result.status !== "untouched") log(`[slim-records] ${id}: ${result.status} (${result.reason})`);
    } catch (error) {
      // a code only, never a message that could quote the record
      log(`[slim-records] ${id}: failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
    }
  }
  return results;
}

/**
 * Sweeps a minute after the bridge starts, then hourly, one sweep at a time; off with
 * `HERDR_WEB_SLIM_RECORDS=off` (then null). `stop()` ends it.
 */
export function startRecordSweep(env: Record<string, string | undefined> = process.env, options: SweepOptions = {}): { stop(): void } | null {
  if (env[KILL_SWITCH] === "off") return null;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void sweepRecords(options).catch(() => {}).finally(() => { running = false; });
  };
  const first = setTimeout(tick, FIRST_SWEEP_MS);
  const timer = setInterval(tick, SWEEP_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}
