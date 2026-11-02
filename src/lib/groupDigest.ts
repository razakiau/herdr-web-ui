/**
 * Chat groups (ZAC-265 PR 2): one group's digest as its page shows it, from the server
 * (server/groups-routes.ts): GET /api/groups/<id>/digest for the digest, the refresh running and the
 * last failure; read again on every groups nudge (a refresh tells each stage), so the card follows a
 * run. The Refresh sheet's models (GET /api/groups/models) and estimates (GET …/digest/estimate) are
 * asked as it needs them and kept; a write is POST …/digest, its progress then read as above.
 */
import { useEffect, useMemo, useState } from "react";

import type { DigestEffort, DigestEstimate, DigestFailure, DigestProgress, GroupDigest, GroupDigestAnswer } from "../../shared/groups.ts";
import { getJson } from "./api.ts";
import { groupsFeed, onGroupsChanged } from "./groups.ts";

/** What the page's digest card and its Refresh sheet are given (GroupPage.tsx DigestControls). */
export interface DigestState {
  digest: GroupDigest | null;
  progress: DigestProgress | null;
  failure: DigestFailure | null;
  spentUsd: number;
  /** some call had no price: the spend is a floor */
  spendIncomplete: boolean;
}

/** The server's answer as the card reads it: the run's phase as its stage, the failure as it is. */
export function digestStateOf(answer: GroupDigestAnswer | null): DigestState {
  if (!answer) return { digest: null, progress: null, failure: null, spentUsd: 0, spendIncomplete: false };
  const writing = answer.writing;
  const progress: DigestProgress | null = !writing ? null : writing.phase === "group" ? { stage: "digest" } : { stage: "summaries", done: writing.done, total: writing.total };
  return { digest: answer.digest, progress, failure: answer.error ?? null, spentUsd: answer.spentUsd, spendIncomplete: answer.spendIncomplete === true };
}

export interface DigestTransport {
  read(groupId: number): Promise<GroupDigestAnswer>;
  write(groupId: number, pick: { model: string; effort: DigestEffort }): Promise<void>;
  models(): Promise<string[]>;
  estimate(groupId: number, model: string, effort: DigestEffort): Promise<DigestEstimate>;
}

const headers = { "content-type": "application/json", "x-herdr-machine": "1" };
export const digestTransport: DigestTransport = {
  read: (groupId) => getJson<GroupDigestAnswer>(`/api/groups/${groupId}/digest`, { cache: "no-store" }),
  write: async (groupId, pick) => { await getJson<{ job: number }>(`/api/groups/${groupId}/digest`, { method: "POST", headers, body: JSON.stringify(pick) }); },
  models: async () => (await getJson<{ models: string[] }>("/api/groups/models", { cache: "no-store" })).models,
  estimate: (groupId, model, effort) => getJson<DigestEstimate>(`/api/groups/${groupId}/digest/estimate?model=${encodeURIComponent(model)}&effort=${effort}`, { cache: "no-store" }),
};

/**
 * One group's digest store: `state()` as last read, `estimate()` answering a kept estimate at once
 * (null while it is asked, `changed` told when it lands), `write()` posting and reading again. A
 * write refused (a run already going, a watching device) reads as a failure under the card.
 */
export function createDigestStore(groupId: number, transport: DigestTransport, changed: () => void, now: () => number = Date.now) {
  let answer: GroupDigestAnswer | null = null;
  let refused: DigestFailure | null = null;
  let models: string[] | null = null;
  let modelsAsked = false;
  const estimates = new Map<string, DigestEstimate | "asked">();
  let flying = false;
  let again = false;
  const read = (): void => {
    if (flying) { again = true; return; }
    flying = true;
    void transport.read(groupId).then((next) => { answer = next; changed(); }, () => undefined).finally(() => {
      flying = false;
      if (again) { again = false; read(); }
    });
  };
  return {
    read,
    state(): DigestState {
      const state = digestStateOf(answer);
      return refused && !state.progress ? { ...state, failure: refused } : state;
    },
    models(): string[] | null {
      if (!modelsAsked) {
        modelsAsked = true;
        void transport.models().then((list) => { models = list; changed(); }, () => { models = []; changed(); });
      }
      return models;
    },
    estimate(model: string, effort: DigestEffort): DigestEstimate | null {
      const key = `${model} ${effort}`;
      const kept = estimates.get(key);
      if (kept === "asked") return null;
      if (kept) return kept;
      estimates.set(key, "asked");
      void transport.estimate(groupId, model, effort).then((estimate) => { estimates.set(key, estimate); changed(); }, () => { estimates.delete(key); });
      return null;
    },
    async write(pick: { model: string; effort: DigestEffort }): Promise<void> {
      refused = null;
      try { await transport.write(groupId, pick); } catch (error) {
        refused = { source: "Ovis", message: error instanceof Error ? error.message : "The digest could not be started", at: new Date(now()).toISOString() };
      }
      // the estimates were for the chats as they were; the default moved to this pick
      estimates.clear();
      groupsFeed.refresh();
      read();
      changed();
    },
  };
}

/** The digest of the group whose page is open (null: none), read again on each groups nudge. */
export function useGroupDigest(groupId: number | null, transport: DigestTransport = digestTransport) {
  const [, setTick] = useState(0);
  const store = useMemo(() => groupId === null ? null : createDigestStore(groupId, transport, () => setTick((tick) => tick + 1)), [groupId, transport]);
  useEffect(() => {
    if (!store) return undefined;
    store.read();
    return onGroupsChanged(store.read);
  }, [store]);
  return store;
}
