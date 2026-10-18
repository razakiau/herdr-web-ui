import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

/** Each request belongs to one immutable pane/history/tool target. Aborting saves
 * work; identity checks also reject responses whose transport ignores cancellation.
 * `target` names it (a URL, fetched as text, unless `read` is given: then `read` fetches it). */
export function useWholeOutput(target: string | null, scope: string, read?: (signal: AbortSignal) => Promise<string>) {
  const owner = useMemo(() => ({ controller: null as AbortController | null, active: true }), [target, scope]);
  const [result, setResult] = useState<{ owner: typeof owner; text: string | null; state: "idle" | "loading" | "failed" } | null>(null);
  const reader = useRef(read);
  reader.current = read;
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.controller?.abort(); owner.controller = null; };
  }, [owner]);
  const load = useCallback(() => {
    if (target === null || !owner.active || owner.controller) return;
    const controller = new AbortController();
    owner.controller = controller;
    const current = () => owner.active && owner.controller === controller && !controller.signal.aborted;
    setResult({ owner, text: null, state: "loading" });
    const fetchText = reader.current ?? (async (signal: AbortSignal) => {
      const response = await fetch(target, { signal });
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    });
    void (async () => {
      try {
        const text = await fetchText(controller.signal);
        if (current()) setResult({ owner, text, state: "idle" });
      } catch {
        if (current()) setResult({ owner, text: null, state: "failed" });
      } finally {
        if (owner.controller === controller) owner.controller = null;
      }
    })();
  }, [target, owner]);
  return { text: result?.owner === owner ? result.text : null, state: result?.owner === owner ? result.state : "idle", load };
}
