import { goalCheckOf } from "./hostGoals.ts";

/**
 * Which user message a host chat pins at its top while its turn is read, as VS Code's chat keeps
 * the request in a sticky row (chat.stickyScroll.enabled): the nearest user message at or above
 * the first row on screen, once that message's own top has scrolled out. `firstTop` is the first
 * row's top minus the view's top (negative: it started above the view). Null when there is none.
 */
export function stickyRequestIndex(roles: readonly string[], first: number, firstTop: number): number | null {
  if (first < 0 || first >= roles.length) return null;
  for (let index = first; index >= 0; index--) {
    if (roles[index] !== "user") continue;
    return index === first && firstTop >= 0 ? null : index;
  }
  return null;
}

/**
 * The role a timeline row counts as for the sticky request: the goal runner's "[Goal, check N]"
 * prompts are user turns, but they show as the judge's verdict, not as the owner's message.
 */
export function stickyRequestRole(role: string, text: string): string {
  return role === "user" && goalCheckOf(text) !== null ? "assistant" : role;
}
