/**
 * Turns for the pictures of the open chat: at most IMAGE_LOADS_AT_ONCE load at a time, first asked
 * first served. A chat with 15 pictures in view asked for all of them at once; over a slow line
 * (a PC at work through NetBird, then the home ADSL) they shared it with the chat's own reads for
 * 17 s and more, the server's 18 s limit cut most of them, and the chat read, the upload and the
 * PC's roster read with them (ZAC-340, 2026-11-20). Two at a time keeps a lane for everything else.
 */
export const IMAGE_LOADS_AT_ONCE = 2;

export interface ImageQueue {
  /** `start` runs once a turn is free; the returned function gives the turn back, or leaves the line if not started yet */
  take(start: () => void): () => void;
  /** loads under way, for tests */
  active(): number;
}

export function createImageQueue(limit = IMAGE_LOADS_AT_ONCE): ImageQueue {
  let active = 0;
  const waiting: { start: () => void }[] = [];
  const next = () => {
    while (active < limit && waiting.length > 0) {
      const turn = waiting.shift()!;
      active++;
      turn.start();
    }
  };
  return {
    take(start) {
      const turn = { start: () => { started = true; start(); } };
      let started = false;
      let done = false;
      waiting.push(turn);
      next();
      return () => {
        if (done) return;
        done = true;
        if (started) { active--; next(); return; }
        const at = waiting.indexOf(turn);
        if (at >= 0) waiting.splice(at, 1);
      };
    },
    active: () => active,
  };
}

/** a picture the browser holds already (an upload's preview) needs no turn */
export function needsTurn(src: string): boolean {
  return !src.startsWith("data:") && !src.startsWith("blob:");
}

export const imageQueue = createImageQueue();
