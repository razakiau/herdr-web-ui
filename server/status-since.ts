import type { AgentStatus } from "../shared/protocol.ts";

/**
 * When each pane entered the status it shows, for the sidebar's "how long" (`status_since`). Only a
 * real change restamps: herdr re-sending the same status keeps the first time.
 */
export class StatusSince {
  private readonly panes = new Map<string, { status: AgentStatus; since: number }>();

  note(paneId: string, status: AgentStatus, now = Date.now()): number {
    const known = this.panes.get(paneId);
    if (known && known.status === status) return known.since;
    this.panes.set(paneId, { status, since: now });
    return now;
  }

  of(paneId: string): number | undefined {
    return this.panes.get(paneId)?.since;
  }

  forget(paneId: string): void {
    this.panes.delete(paneId);
  }
}
