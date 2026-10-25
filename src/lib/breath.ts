import type { AnimationEvent } from "react";

/**
 * Every breathing dot or glyph (sidebar-breathe: the sidebar's, a tab's, a working group's) keeps
 * the document clock's phase, so one that starts working breathes in step with the rest.
 */
export function alignBreath(event: AnimationEvent<HTMLElement>): void {
  if (event.animationName !== "sidebar-breathe") return;
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}
