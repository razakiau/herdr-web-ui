/** How long a pane has been in its state, as the Agents list's state cell says it: now, 4m, 2h, 3d. */
export type Since = { unit: "now" } | { unit: "m" | "h" | "d"; n: number };

export function sinceOf(since: number | undefined, now: number): Since | null {
  if (since === undefined) return null;
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "m", n: minutes };
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? { unit: "h", n: hours } : { unit: "d", n: Math.floor(hours / 24) };
}
