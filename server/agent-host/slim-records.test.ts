import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BLANK_PNG, slimRecord, startRecordSweep, sweepRecords } from "./slim-records.ts";

const ID = "9585e1b9-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-11-16T10:00:00");
const HOUR = 3_600_000;
/** a picture's base64, big enough that slimming shows in the size */
const PICTURE = Buffer.alloc(30_000, 7).toString("base64");

let home: string;
let record: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slim-records-"));
  mkdirSync(join(home, "session-state", ID), { recursive: true });
  record = join(home, "session-state", ID, "events.jsonl");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const hash = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
let ids = 0;
/** events as Copilot CLI 1.0.105 writes them: `type` first, then `data` */
const event = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: `ev-${++ids}`, timestamp: "2026-11-15T10:00:00.000Z", parentId: null });
const asset = (n: number, mimeType = "image/png") => event("session.binary_asset", { assetId: hash(n), type: "image", mimeType, byteLength: 30_000, data: PICTURE, description: `Image file at path /tmp/shot-${n}.png` });
const start = () => event("session.compaction_start", {});
const complete = () => event("session.compaction_complete", { success: true, summaryContent: "the story so far" });
const user = (text: string) => event("user.message", { content: text });
const toolResult = (n: number) => event("tool.execution_complete", { toolCallId: "t", success: true, result: { content: "seen", binaryResultsForLlm: [{ type: "image", assetId: hash(n), mimeType: "image/png" }] } });

function write(lines: string[]): void {
  writeFileSync(record, lines.join("\n") + "\n");
  const old = (NOW.getTime() - 2 * HOUR) / 1000;
  utimesSync(record, old, old);
}
const events = () => readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as { type: string; id: string; data: Record<string, unknown> }; } catch { return line; } });
const picture = (n: number) => events().find((e) => typeof e !== "string" && e.type === "session.binary_asset" && e.data["assetId"] === hash(n)) as { id: string; data: Record<string, unknown> };
const slim = (extra: Partial<Parameters<typeof slimRecord>[1]> = {}) => slimRecord(record, { id: ID, backupDir: join(home, "session-state-backups"), now: NOW, ...extra });

describe("slimRecord", () => {
  test("blanks a picture before the cut that nothing after it names, keeping its ids and description", async () => {
    write([user("look"), asset(1), start(), complete(), user("go on")]);
    const before = picture(1);
    const result = await slim();
    expect(result).toMatchObject({ status: "slimmed", blanked: 1, kept: 0 });
    const after = picture(1);
    expect(after.data).toEqual({ assetId: hash(1), type: "image", mimeType: "image/png", byteLength: 68, data: BLANK_PNG, description: "Image file at path /tmp/shot-1.png" });
    expect(after.id).toBe(before.id);
    expect(statSync(record).size).toBeLessThan(10_000);
  });

  test("the cut is the latest start before the LAST complete; a picture between that start and complete stays", async () => {
    write([asset(1), start(), complete(), asset(2), start(), asset(3), complete(), asset(4)]);
    const result = await slim();
    expect(result).toMatchObject({ status: "slimmed", blanked: 2, kept: 2 });
    expect(picture(1).data["data"]).toBe(BLANK_PNG);
    expect(picture(2).data["data"]).toBe(BLANK_PNG);
    expect(picture(3).data["data"]).toBe(PICTURE);
    expect(picture(4).data["data"]).toBe(PICTURE);
  });

  test("keeps a picture before the cut that an event after it names (assets are shared by hash)", async () => {
    write([asset(1), asset(2), start(), complete(), toolResult(1)]);
    const result = await slim();
    expect(result).toMatchObject({ status: "slimmed", blanked: 1, kept: 1 });
    expect(picture(1).data["data"]).toBe(PICTURE);
    expect(picture(2).data["data"]).toBe(BLANK_PNG);
  });

  test("touches nothing without a compaction, nor a record whose old pictures are all still named", async () => {
    write([asset(1), user("no compaction yet"), start()]);
    const text = readFileSync(record);
    expect(await slim()).toEqual({ status: "untouched", reason: "no-compaction", kept: 1 });
    expect(readFileSync(record).equals(text)).toBe(true);
    write([asset(1), start(), complete(), toolResult(1)]);
    expect(await slim()).toEqual({ status: "untouched", reason: "nothing-to-blank", kept: 1 });
    expect(existsSync(join(home, "session-state-backups"))).toBe(false);
  });

  test("blanks pictures only, and copies malformed lines and every other line byte for byte", async () => {
    const other = event("session.binary_asset", { assetId: hash(5), type: "file", mimeType: "application/pdf", byteLength: 30_000, data: PICTURE });
    const lines = ["{not json at all", asset(1), other, user("caf\u00e9 \u{1F600}"), start(), complete(), "{\"type\":\"user.message\",\"data\":"];
    writeFileSync(record, lines.join("\n")); // no newline at the end either
    utimesSync(record, (NOW.getTime() - 2 * HOUR) / 1000, (NOW.getTime() - 2 * HOUR) / 1000);
    expect(await slim()).toMatchObject({ status: "slimmed", blanked: 1 });
    const out = readFileSync(record, "utf8").split("\n");
    expect(out.length).toBe(lines.length);
    out.forEach((line, i) => { if (i !== 1) expect(line).toBe(lines[i]!); });
    expect((JSON.parse(out[1]!) as { data: { data: string } }).data.data).toBe(BLANK_PNG);
  });

  test("blanks a picture written in another layout too, by parsing its line", async () => {
    const reordered = JSON.stringify({ id: "ev-r", data: { data: PICTURE, description: "d", byteLength: 30_000, mimeType: "image/jpeg", type: "image", assetId: hash(6) }, type: "session.binary_asset", timestamp: "t" });
    write([reordered, start(), complete()]);
    expect(await slim()).toMatchObject({ status: "slimmed", blanked: 1 });
    expect(events()[0] as unknown).toEqual({ id: "ev-r", data: { data: BLANK_PNG, description: "d", byteLength: 68, mimeType: "image/png", type: "image", assetId: hash(6) }, type: "session.binary_asset", timestamp: "t" });
  });

  test("first writes a backup of the original, once", async () => {
    write([asset(1), start(), complete()]);
    const original = readFileSync(record);
    const result = await slim();
    const backup = join(home, "session-state-backups", `${ID}-events-2026-11-16.jsonl`);
    expect(result).toMatchObject({ status: "slimmed", backup });
    expect(readFileSync(backup).equals(original)).toBe(true);
    // its age counts from when it was written, not from the record's last write
    expect(Math.abs(statSync(backup).mtimeMs - Date.now())).toBeLessThan(60_000);
    // a second slim the same day leaves the first backup as it was
    appendFileSync(record, asset(2) + "\n" + start() + "\n" + complete() + "\n");
    await slim();
    expect(readFileSync(backup).equals(original)).toBe(true);
  });

  test("aborts when the record changes during the rewrite, leaving the original whole and no temp file", async () => {
    write([asset(1), start(), complete()]);
    const appended = user("written while slimming");
    const result = await slim({ beforeRename: () => appendFileSync(record, appended + "\n") });
    expect(result).toEqual({ status: "aborted", reason: "changed" });
    expect(picture(1).data["data"]).toBe(PICTURE);
    expect(readFileSync(record, "utf8").endsWith(appended + "\n")).toBe(true);
    expect(readdirSync(join(home, "session-state", ID))).toEqual(["events.jsonl"]);
  });

  test("skips the record when the disk lacks twice its size", async () => {
    write([asset(1), start(), complete()]);
    const text = readFileSync(record);
    expect(await slim({ freeBytes: () => text.length })).toEqual({ status: "skipped", reason: "disk-space" });
    expect(readFileSync(record).equals(text)).toBe(true);
  });
});

describe("sweepRecords", () => {
  test("slims only big idle records under COPILOT_HOME's session-state, one log line each", async () => {
    write([asset(1), start(), complete()]);
    const busy = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    mkdirSync(join(home, "session-state", busy));
    const busyRecord = join(home, "session-state", busy, "events.jsonl");
    writeFileSync(busyRecord, [asset(2), start(), complete()].join("\n") + "\n");
    utimesSync(busyRecord, (NOW.getTime() - 5 * 60_000) / 1000, (NOW.getTime() - 5 * 60_000) / 1000);
    const logs: string[] = [];
    const results = await sweepRecords({ home, thresholdBytes: 1_000, now: () => NOW, log: (line) => logs.push(line), freeBytes: () => Infinity });
    // the busy one was written 5 minutes ago
    expect(results.map((r) => [r.id, r.result.status])).toEqual([[ID, "slimmed"]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^\\[slim-records\\] ${ID}: \\d+\\.\\d MB -> 0\\.0 MB, 1 pictures blanked, 0 kept$`));
    expect(await sweepRecords({ home, thresholdBytes: 10_000_000, now: () => NOW, log: (line) => logs.push(line) })).toEqual([]);
  });

  test("deletes its own backups older than 14 days, and leaves recent and hand-made ones", async () => {
    const dir = join(home, "session-state-backups");
    mkdirSync(dir);
    const at = (name: string, days: number) => {
      writeFileSync(join(dir, name), "x");
      const t = (NOW.getTime() - days * 24 * HOUR) / 1000;
      utimesSync(join(dir, name), t, t);
    };
    const old = `${ID}-events-2026-10-01.jsonl`, recent = `${ID}-events-2026-11-10.jsonl`;
    at(old, 15);
    at(recent, 6);
    at("9585e1b9-events-2026-10-01.jsonl", 40);
    at("d565b469-events-2026-10-02.jsonl", 40);
    at(`${ID}-events-2026-10-01.jsonl.123.tmp`, 40);
    at(`${ID}-notes-2026-10-01.jsonl`, 40);
    const logs: string[] = [];
    await sweepRecords({ home, now: () => NOW, log: (line) => logs.push(line) });
    expect(readdirSync(dir).sort()).toEqual([`${ID}-events-2026-10-01.jsonl.123.tmp`, recent, `${ID}-notes-2026-10-01.jsonl`, "9585e1b9-events-2026-10-01.jsonl", "d565b469-events-2026-10-02.jsonl"].sort());
    expect(logs).toEqual([`[slim-records] deleted backup ${old} (0.0 MB)`]);
  });

  test("HERDR_WEB_SLIM_RECORDS=off starts no sweep", () => {
    expect(startRecordSweep({ HERDR_WEB_SLIM_RECORDS: "off" }, { home })).toBeNull();
    const sweep = startRecordSweep({}, { home });
    expect(sweep).not.toBeNull();
    sweep?.stop();
  });
});
