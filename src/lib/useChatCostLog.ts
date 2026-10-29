/**
 * The bridge's log of the open chat (ZAC-260) while costs are tracked, for the meter's cache timer,
 * the handoff banner and the Session sheet: asked when the chat opens, when a turn ends and on each
 * open of the sheet; never on a timer (the minute clock moves the cache's state). undefined while
 * asked, null from a bridge before costs.
 */
import { useEffect, useRef, useState } from "react";

import type { HostChatCost, HostCostCall } from "../../shared/host-chats.ts";
import { fetchChatCost } from "./hostChats.ts";

export type ChatCostLog = { chat: HostChatCost | null; calls: HostCostCall[] } | null;

export function useChatCostLog(
  { machineId, session, trackCosts, busy, sheetOpen }: { machineId: string; session: string; trackCosts: boolean; busy: boolean; sheetOpen: boolean },
  fetcher: (machineId: string, session: string) => Promise<ChatCostLog> = fetchChatCost,
): ChatCostLog | undefined {
  const [log, setLog] = useState<ChatCostLog | undefined>(undefined);
  const asked = useRef(false);
  // the newest request and the chat it was for: an answer lands only if it is still both. Not the
  // effect's cleanup, which a turn starting would run and so drop the answer a busy chat opened on.
  const latest = useRef({ n: 0, key: "" });
  const key = `${machineId}\n${session}`;
  useEffect(() => {
    if (latest.current.key !== key) { latest.current = { n: latest.current.n + 1, key }; setLog(undefined); asked.current = false; }
    if (!trackCosts) { asked.current = false; return; }
    // a turn starting changes nothing the log says yet: asked again when it ends
    if (asked.current && busy && !sheetOpen) return;
    asked.current = true;
    const n = ++latest.current.n;
    const ours = (): boolean => latest.current.n === n && latest.current.key === key;
    void fetcher(machineId, session).then((value) => { if (ours()) setLog(value); }, () => { /* kept: the last answer, or still asking */ });
  }, [sheetOpen, trackCosts, machineId, session, key, busy, fetcher]);
  useEffect(() => () => { latest.current = { n: latest.current.n + 1, key: "" }; }, []);
  return log;
}
