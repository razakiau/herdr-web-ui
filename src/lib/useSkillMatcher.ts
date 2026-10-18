import { useEffect, useState } from "react";

import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands } from "./paneCommandCache.ts";
import { createSkillMatcher, type SkillMatcher } from "./skillMentions.ts";

/** The pane's skill names as a matcher, from its command list; null until it loads, or when it fails, and with no pane (null: a host chat's). */
export function useSkillMatcher(paneId: string | null): SkillMatcher | null {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const [loaded, setLoaded] = useState<{ key: string; matcher: SkillMatcher | null } | null>(null);
  const key = `${machineId}:${paneId}`;
  useEffect(() => {
    if (paneId === null) return;
    let live = true;
    cachedPaneCommands(paneId, machineId, fetchPaneCommands).then(
      (commands) => { if (live) setLoaded({ key, matcher: createSkillMatcher(commands) }); },
      () => { if (live) setLoaded({ key, matcher: null }); },
    );
    return () => { live = false; };
  }, [fetchPaneCommands, paneId, machineId, key]);
  return paneId !== null && loaded?.key === key ? loaded.matcher : null;
}
