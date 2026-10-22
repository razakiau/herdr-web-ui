import type { AgentStatus } from "../../shared/protocol.ts";
import { shouldNotifyStatus, type AlertPrefs } from "../../shared/notify-policy.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";

/**
 * In-app alerts: a notice that drops from the top edge while the app is on screen.
 * A push to a device whose app is visible arrives silent (public/sw.js), and the tab
 * alerts stay quiet in a visible tab (lib/notifications.ts), so without this an agent
 * that waits on the user while the app is open says so nowhere but its sidebar row.
 *
 * App decides what is news (shared/notify-policy.ts, as the other alerts do) and calls
 * showDroplet(); components/Droplet.tsx is the one place that draws them.
 */

export type DropletKind = "blocked" | "done" | "ended" | "error";

export interface DropletNotice {
  machineId: string;
  /** the pane it is about; a host chat's notice has none and names its `session` */
  paneId: string;
  session?: string;
  agent: string | null;
  /** the pane's name, as the sidebar shows it */
  title: string;
  /** the machine's name, shown beside what happened when there is more than one */
  machine: string | null;
  kind: DropletKind;
}

export interface QueuedDroplet extends DropletNotice {
  id: number;
}

/** A finished turn this long or longer is a "long turn" (server/push.ts DEFAULT_ALERT_TIMING.longTurn). */
export const LONG_TURN_MS = 60_000;
/** The same notice for the same pane this soon again is one notice. */
export const DROPLET_REPEAT_MS = 400;

/**
 * Whether this device wants to hear about a status at all, the finished-turn length included:
 * `worked` is how long the pane worked before it finished, null when this page did not see
 * it start (then it is told, as the server does).
 */
export function dropletAllows(prefs: AlertPrefs, status: AgentStatus, worked: number | null): boolean {
  if (status === "blocked") return prefs.input;
  if (status !== "done" || prefs.done === "off") return false;
  if (prefs.done === "always") return true;
  return worked === null || worked >= LONG_TURN_MS;
}

/**
 * What a roster does to the statuses this page remembers (by paneStorageId). The server reads
 * the roster from herdr on its own, so a roster can show a change before the event that tells
 * of it arrives. A change that is news (shouldNotifyStatus) is therefore left to its event:
 * taken from the roster, the event would be no change and the alert would be lost. Any other
 * change is taken, with the turn's clock kept as an event would keep it: that is how the page
 * catches up after status events were lost, and a wait that follows is news again. A pane
 * first seen is taken as it is, and one no PC lists any more is forgotten.
 */
export function seedStatuses(
  known: Map<string, AgentStatus>,
  machines: readonly { id: string; snapshot?: { panes: readonly { pane_id: string; agent_status: AgentStatus }[] } | null }[],
  turns: { started: Map<string, number>; lasted: Map<string, number> } = { started: new Map(), lasted: new Map() },
  now = Date.now(),
): void {
  const listed = new Set<string>();
  for (const machine of machines) for (const pane of machine.snapshot?.panes ?? []) {
    const key = paneStorageId(machine.id, pane.pane_id);
    listed.add(key);
    const previous = known.get(key);
    if (previous === pane.agent_status || shouldNotifyStatus(previous, pane.agent_status)) continue;
    known.set(key, pane.agent_status);
    const worked = trackTurn(turns.started, key, previous, pane.agent_status, now);
    if (worked !== null) turns.lasted.set(key, worked);
  }
  for (const key of [...known.keys()]) if (!listed.has(key)) known.delete(key);
}

/**
 * When a pane's turn began, by pane, so a finished one knows how long it worked: from working
 * or blocked entered until it is at rest again, as server/push.ts measures it. Returns how
 * long the turn took when the pane comes to rest, null while busy or when its start was not seen.
 */
export function trackTurn(started: Map<string, number>, key: string, previous: AgentStatus | undefined, next: AgentStatus, now: number): number | null {
  const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
  if (busy(next)) {
    // a first sighting mid-turn has no start: its length stays unknown
    if (previous !== undefined && !busy(previous)) started.set(key, now);
    return null;
  }
  const since = started.get(key);
  started.delete(key);
  return since === undefined ? null : now - since;
}

/**
 * How long the turn before a pane's end took, for the same finished-turn choice: the turn it
 * ended in the middle of, else the last one it finished (kept by the caller in `lasted`),
 * null when this page saw neither. The pane is gone, so both records go with it.
 */
export function endedTurn(started: Map<string, number>, lasted: Map<string, number>, key: string, now: number): number | null {
  const since = started.get(key);
  const last = lasted.get(key);
  started.delete(key);
  lasted.delete(key);
  if (since !== undefined) return now - since;
  return last ?? null;
}

export interface HostChatDroplet { session: string; title: string; kind: "blocked" | "done" | "error" }

/**
 * What one PC's host chats did between two reads of its list that is news, as server/push.ts
 * onHostChats tells ntfy and the devices: asks, a turn finished (from working or asks), or a
 * failure, which is told as a finish is. A chat first seen (`before` undefined: the page just
 * read the PC) or archived says nothing. `turns` keeps when each chat's turn began, by session,
 * for the device's long-turn choice.
 */
export function hostChatDroplets(before: readonly HostChatRow[] | undefined, after: readonly HostChatRow[], turns: Map<string, number>, prefs: AlertPrefs, now: number): HostChatDroplet[] {
  const busy = (status: HostChatRow["status"] | undefined): boolean => status === "working" || status === "asks";
  const was = new Map((before ?? []).map((row) => [row.session, row.status]));
  const out: HostChatDroplet[] = [];
  for (const row of after) {
    const previous = was.get(row.session);
    if (before === undefined || previous === undefined || previous === row.status) continue;
    let worked: number | null = null;
    if (busy(row.status)) {
      if (!busy(previous)) turns.set(row.session, now);
    } else {
      const since = turns.get(row.session);
      turns.delete(row.session);
      worked = since === undefined ? null : now - since;
    }
    if (row.archived) continue;
    const kind = row.status === "asks" ? "blocked" : row.status === "error" ? "error" : row.status === "idle" && busy(previous) ? "done" : null;
    if (kind === null || !dropletAllows(prefs, kind === "blocked" ? "blocked" : "done", worked)) continue;
    out.push({ session: row.session, title: row.title, kind });
  }
  const listed = new Set(after.map((row) => row.session));
  for (const session of [...turns.keys()]) if (!listed.has(session)) turns.delete(session);
  return out;
}

/** Only movement this recent counts as a flick: a finger that rested first has not slowed it. */
export const FLICK_WINDOW_MS = 100;

export interface PressSample {
  y: number;
  t: number;
}

/**
 * The vertical speed at release (px per ms, up is negative), over the samples of the last
 * FLICK_WINDOW_MS only. Measured over the whole press, a hold before a flick reads as slow.
 */
export function flickVelocity(samples: readonly PressSample[], y: number, now: number): number {
  const from = samples.find((sample) => now - sample.t <= FLICK_WINDOW_MS);
  return from ? (y - from.y) / Math.max(1, now - from.t) : 0;
}

type Listener = (notice: QueuedDroplet) => void;
const listeners = new Set<Listener>();
let nextId = 1;
const lastShown = new Map<string, number>();

/** Shows a notice in the open app; false when nothing draws them (no Droplet mounted) or it repeats one just shown. */
export function showDroplet(notice: DropletNotice, now = Date.now()): boolean {
  if (listeners.size === 0) return false;
  const key = `${notice.machineId}\n${notice.session ?? notice.paneId}\n${notice.kind}`;
  const last = lastShown.get(key);
  if (last !== undefined && now - last < DROPLET_REPEAT_MS) return false;
  lastShown.set(key, now);
  const queued = { ...notice, id: nextId++ };
  for (const listener of listeners) listener(queued);
  return true;
}

export function onDroplet(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
