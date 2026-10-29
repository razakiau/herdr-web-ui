import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { HostChatCost } from "../../shared/host-chats.ts";
import { useChatCostLog, type ChatCostLog } from "./useChatCostLog.ts";

type Props = { session: string; busy: boolean; sheetOpen?: boolean; trackCosts?: boolean };
const answer = (session: string): NonNullable<ChatCostLog> => ({
  chat: { session, models: [], lastCallAt: null, context: 1000, peak: 1000, rewrites: 0, days: {}, partial: false } satisfies HostChatCost,
  calls: [],
});

let asked: { session: string; resolve(value: ChatCostLog): void }[];
let shown: ChatCostLog | undefined;
let renderer: ReactTestRenderer | undefined;
const fetcher = (_machine: string, session: string): Promise<ChatCostLog> => new Promise((resolve) => { asked.push({ session, resolve }); });

function Probe({ session, busy, sheetOpen = false, trackCosts = true }: Props) {
  shown = useChatCostLog({ machineId: "desk", session, trackCosts, busy, sheetOpen }, fetcher);
  return null;
}
const draw = (props: Props): void => {
  act(() => {
    if (renderer) renderer.update(createElement(Probe, props));
    else renderer = create(createElement(Probe, props));
  });
};

const saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeEach(() => {
  asked = []; shown = undefined; renderer = undefined;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(() => {
  act(() => renderer?.unmount());
  if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("useChatCostLog", () => {
  it("keeps the first answer when the chat turns out busy while it is asked", async () => {
    // the chat opens before its read says a turn runs: the mount's request is the only one until the turn ends
    draw({ session: "s:/a", busy: false });
    draw({ session: "s:/a", busy: true });
    expect(asked.map((each) => each.session)).toEqual(["s:/a"]);
    await act(async () => { asked[0]!.resolve(answer("s:/a")); });
    expect(shown?.chat?.session).toBe("s:/a");
  });

  it("asks again when the turn ends", () => {
    draw({ session: "s:/a", busy: true });
    draw({ session: "s:/a", busy: false });
    expect(asked).toHaveLength(2);
  });

  it("drops an answer for a chat no longer open", async () => {
    draw({ session: "s:/a", busy: false });
    draw({ session: "s:/b", busy: false });
    await act(async () => { asked[0]!.resolve(answer("s:/a")); });
    expect(shown).toBeUndefined();
    await act(async () => { asked[1]!.resolve(answer("s:/b")); });
    expect(shown?.chat?.session).toBe("s:/b");
  });

  it("keeps the newest answer when an older one for the same chat lands after it", async () => {
    draw({ session: "s:/a", busy: true });
    draw({ session: "s:/a", busy: false });
    const older = answer("s:/a");
    const newer = { ...answer("s:/a"), calls: [{ at: "", input: 1, cacheRead: 0, cacheWrite: 0, output: 0, main: true, context: 1, lastCacheRead: 0 }] };
    await act(async () => { asked[1]!.resolve(newer); });
    await act(async () => { asked[0]!.resolve(older); });
    expect(shown).toBe(newer);
  });

  it("asks nothing while costs are not tracked", () => {
    draw({ session: "s:/a", busy: false, trackCosts: false });
    expect(asked).toHaveLength(0);
  });
});
