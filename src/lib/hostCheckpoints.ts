import type { HostCheckpoint } from "../../shared/host-chats.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

/** A shown row's checkpoint: a user message's turn (`turn` set), or a row only faded after a restore. */
export interface CheckpointRow { turn: string | null; first: boolean; files: HostCheckpoint["files"]; faded: boolean }

/**
 * Each shown row's checkpoint, by row index. The read's turns are the chat's newest window, one
 * checkpoint per host turn, and each host turn is one user row: so the shown user rows pair with
 * the checkpoints counted from the newest back. The chat's first message (and only when the rows
 * reach the chat's start: `older` is false) is VS Code's Start Over. With `restored`, that message
 * and every row after it are faded.
 */
export function checkpointRows(turns: readonly ConversationTurn[], checkpoints: readonly HostCheckpoint[], restored: string | null, older: boolean): Map<number, CheckpointRow> {
  const rows = new Map<number, CheckpointRow>();
  const users = turns.flatMap((turn, index) => (turn.role === "user" ? [index] : []));
  let fadeFrom = -1;
  for (let back = 1; back <= Math.min(users.length, checkpoints.length); back++) {
    const index = users[users.length - back]!;
    const checkpoint = checkpoints[checkpoints.length - back]!;
    const first = !older && checkpoints.length - back === 0 && back === users.length;
    rows.set(index, { turn: checkpoint.turn, first, files: checkpoint.files, faded: false });
    if (checkpoint.turn === restored) fadeFrom = index;
  }
  if (fadeFrom >= 0) {
    for (let index = fadeFrom; index < turns.length; index++) {
      const row = rows.get(index);
      rows.set(index, row ? { ...row, faded: true } : { turn: null, first: false, files: [], faded: true });
    }
  }
  return rows;
}
