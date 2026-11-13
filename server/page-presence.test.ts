import { describe, expect, it } from "bun:test";

import { BRIDGE_PRESENCE_TTL_MS, BridgePresence, handleBridgePresenceRequest, handlePresenceRequest, PagePresence, PresenceRelay } from "./page-presence.ts";

const post = (body: unknown, method = "POST") => new Request("http://127.0.0.1/api/presence", { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });

describe("PagePresence", () => {
  it("is in use while any page says so, and not once the last says it left", () => {
    const presence = new PagePresence();
    expect(presence.inUse()).toBe(false);
    presence.set("page-aaaaaaaa", true);
    presence.set("page-bbbbbbbb", true);
    expect(presence.inUse()).toBe(true);
    presence.set("page-aaaaaaaa", false);
    expect(presence.inUse()).toBe(true);
    presence.set("page-bbbbbbbb", false);
    expect(presence.inUse()).toBe(false);
  });

  it("forgets a page that stops saying so, so a killed app cannot mute alerts", () => {
    let now = 0;
    const presence = new PagePresence(45_000, () => now);
    presence.set("page-aaaaaaaa", true);
    now = 44_999;
    expect(presence.inUse()).toBe(true);
    // a heartbeat renews it
    presence.set("page-aaaaaaaa", true);
    now = 89_000;
    expect(presence.inUse()).toBe(true);
    now = 90_000;
    expect(presence.inUse()).toBe(false);
  });
});

describe("POST /api/presence", () => {
  it("records a page's word", async () => {
    const presence = new PagePresence();
    expect((await handlePresenceRequest(post({ page: "0f1e2d3c-aaaa", active: true }), presence)).status).toBe(204);
    expect(presence.inUse()).toBe(true);
    expect((await handlePresenceRequest(post({ page: "0f1e2d3c-aaaa", active: false }), presence)).status).toBe(204);
    expect(presence.inUse()).toBe(false);
  });

  it("refuses anything but a page id and a boolean", async () => {
    const presence = new PagePresence();
    for (const body of [{}, { page: "x", active: true }, { page: "0f1e2d3c-aaaa", active: "yes" }, { page: "../../etc/passwd!", active: true }]) {
      expect((await handlePresenceRequest(post(body), presence)).status).toBe(400);
    }
    expect((await handlePresenceRequest(post(null, "GET"), presence)).status).toBe(400);
    expect(presence.inUse()).toBe(false);
  });
});

describe("presence on the bridges (ask_user_async, ZAC-326)", () => {
  const bridgePost = (body: unknown) => new Request("http://127.0.0.1/api/host-chats/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("presence reaches the bridge", async () => {
    let now = 0;
    const pages = new PagePresence(45_000, () => now);
    // the bridge's store, as far as presence goes
    const told: boolean[] = [];
    const bridge = new BridgePresence(() => false, (inUse) => told.push(inUse), BRIDGE_PRESENCE_TTL_MS, () => now);
    // the central server's relay posts to the bridge as it posts any /api/host-chats/ call: its address and token
    const posted: { url: string; auth: string | null; body: unknown }[] = [];
    const relay = new PresenceRelay({
      inUse: () => pages.inUse(),
      targets: () => [{ url: "http://fictional-bridge", token: "FICTIONAL-token" }],
      fetch: async (url, init) => {
        const request = new Request(url, init);
        posted.push({ url, auth: request.headers.get("authorization"), body: await request.clone().json() });
        return handleBridgePresenceRequest(request, bridge);
      },
      now: () => now,
    });
    await relay.tick();
    expect(told).toEqual([false]);
    pages.set("page-aaaaaaaa", true);
    await relay.tick();
    pages.set("page-aaaaaaaa", false);
    await relay.tick();
    expect(told).toEqual([false, true, false]);
    expect(posted.map((each) => each.body)).toEqual([{ in_use: false }, { in_use: true }, { in_use: false }]);
    expect(posted[0]).toMatchObject({ url: "http://fictional-bridge/api/host-chats/presence", auth: "Bearer FICTIONAL-token" });
    // no change: said again only every 30 s
    now += 29_000; await relay.tick();
    expect(posted.length).toBe(3);
    now += 1_000; await relay.tick();
    expect(posted.length).toBe(4);
  });

  it("a bridge that hears nothing for 60 s counts as not in use", () => {
    let now = 0;
    let local = false;
    const told: boolean[] = [];
    const bridge = new BridgePresence(() => local, (inUse) => told.push(inUse), BRIDGE_PRESENCE_TTL_MS, () => now);
    bridge.report(true);
    now = 59_999;
    expect(bridge.inUse()).toBe(true);
    now = 60_000;
    expect(bridge.inUse()).toBe(false);
    bridge.sync();
    expect(told).toEqual([true, false]);
    // a page on the bridge's own PC counts without any report
    local = true;
    expect(bridge.inUse()).toBe(true);
  });

  it("the bridge's route takes { in_use } only", async () => {
    const told: boolean[] = [];
    const bridge = new BridgePresence(() => false, (inUse) => told.push(inUse));
    expect((await handleBridgePresenceRequest(bridgePost({ in_use: true }), bridge)).status).toBe(204);
    expect(told).toEqual([true]);
    for (const body of [{}, { in_use: "yes" }, null]) expect((await handleBridgePresenceRequest(bridgePost(body), bridge)).status).toBe(400);
    expect((await handleBridgePresenceRequest(new Request("http://127.0.0.1/api/host-chats/presence"), bridge)).status).toBe(400);
    expect(told).toEqual([true]);
  });
});
