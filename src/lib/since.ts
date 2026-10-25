/** How long a pane has been in its state, as the Agents list's state cell says it: now, 4m, 2h, 3d. */
export function formatSince(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
