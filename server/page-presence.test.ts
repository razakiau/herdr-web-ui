import { describe, expect, it } from "bun:test";

import { BRIDGE_PRESENCE_TTL_MS, BridgePresence, handleBridgePresenceRequest, handlePresenceRequest, PagePresence, PRESENCE_RELAY_MS, PresenceRelay, presenceRelayFor } from "./page-presence.ts";

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
    const bridge = new BridgePresence(() => false, (inUse) => told.push(inUse), () => {}, BRIDGE_PRESENCE_TTL_MS, () => now);
    // the central server's relay posts to the bridge as it posts any /api/host-chats/ call: its address and token
    const posted: { url: string; auth: string | null; body: unknown }[] = [];
    const relay = new PresenceRelay({
      inUse: () => pages.inUse(),
      targets: () => [{ id: "pc-fictional", url: "http://fictional-bridge", token: "FICTIONAL-token" }],
      waiting: () => [],
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
    expect(posted.map((each) => each.body)).toEqual([{ in_use: false, wait: [] }, { in_use: true, wait: [] }, { in_use: false, wait: [] }]);
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
    const bridge = new BridgePresence(() => local, (inUse) => told.push(inUse), () => {}, BRIDGE_PRESENCE_TTL_MS, () => now);
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

  it("the relay tells each bridge the chats whose goal waits for the owner, and again at once when its list changes", async () => {
    const lists: Record<string, string[]> = { "pc-a": ["s1"], "pc-b": [] };
    const posted: { url: string; body: unknown }[] = [];
    const relay = new PresenceRelay({
      inUse: () => false,
      targets: () => [{ id: "pc-a", url: "http://fictional-a", token: "FICTIONAL-token" }, { id: "pc-b", url: "http://fictional-b", token: "FICTIONAL-token" }],
      waiting: (machineId) => lists[machineId] ?? [],
      fetch: async (url, init) => { posted.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); },
      now: () => 0,
    });
    await relay.tick();
    expect(posted.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "http://fictional-a/api/host-chats/presence", body: { in_use: false, wait: ["s1"] } },
      { url: "http://fictional-b/api/host-chats/presence", body: { in_use: false, wait: [] } },
    ]);
    await relay.tick();
    expect(posted.length).toBe(2);
    lists["pc-a"] = ["s1", "s2"];
    await relay.tick();
    expect(posted.slice(2)).toEqual([{ url: "http://fictional-a/api/host-chats/presence", body: { in_use: false, wait: ["s1", "s2"] } }]);
  });

  it("the bridge's route hands on the wait list, keeps the last one when an older connection server sends none, and refuses a bad one", async () => {
    const waits: string[][] = [];
    const bridge = new BridgePresence(() => false, () => {}, (sessions) => waits.push([...sessions]));
    expect((await handleBridgePresenceRequest(bridgePost({ in_use: false, wait: ["s1"] }), bridge)).status).toBe(204);
    expect((await handleBridgePresenceRequest(bridgePost({ in_use: true }), bridge)).status).toBe(204);
    expect(waits).toEqual([["s1"]]);
    for (const wait of [[1], "s1", null, Array.from({ length: 501 }, (_, i) => `s${i}`)]) {
      expect((await handleBridgePresenceRequest(bridgePost({ in_use: false, wait }), bridge)).status).toBe(400);
    }
    expect((await handleBridgePresenceRequest(bridgePost({ in_use: false, wait: Array.from({ length: 500 }, (_, i) => `s${i}`) }), bridge)).status).toBe(204);
    expect(waits.length).toBe(2);
  });

  it("the relay tells remote bridges whether host chats run on the connection server or not", async () => {
    // presenceRelayFor takes no host chats switch: a connection server with them off still relays to a remote PC that has them
    const machines = {
      list: () => [
        { id: "local", kind: "local", state: "connected" },
        { id: "pc-on", kind: "ssh", state: "connected" },
        { id: "pc-off", kind: "ssh", state: "reconnecting" },
      ],
      endpoint: (id: string) => ({ url: `http://fictional-${id}`, token: "FICTIONAL-token" }),
    };
    const posted: string[] = [];
    const relay = presenceRelayFor(machines, () => true, () => [], async (url) => { posted.push(url); return new Response(null, { status: 204 }); })!;
    await relay.tick();
    // the local PC reads its pages itself; one not connected is not asked
    expect(posted).toEqual(["http://fictional-pc-on/api/host-chats/presence"]);
    expect(presenceRelayFor(null, () => true, () => [], fetch)).toBeNull();
  });

  it("a bridge that refuses or is gone is asked \"not in use\" again only after 30 s, or at once on a change", async () => {
    let now = 0;
    let inUse = false;
    let status = 404;
    const posted: string[] = [];
    const relay = new PresenceRelay({
      inUse: () => inUse,
      targets: () => [{ id: "pc-old", url: "http://fictional-old", token: "FICTIONAL-token" }, { id: "pc-gone", url: "http://fictional-gone", token: "FICTIONAL-token" }],
      waiting: () => [],
      fetch: async (url) => {
        posted.push(url);
        if (url.startsWith("http://fictional-gone")) throw new Error("FICTIONAL refused");
        return new Response(null, { status });
      },
      now: () => now,
    });
    await relay.tick();
    expect(posted.length).toBe(2);
    // the 5 s checks in between ask neither again
    for (now = 5_000; now < PRESENCE_RELAY_MS; now += 5_000) await relay.tick();
    expect(posted.length).toBe(2);
    // PRESENCE_RELAY_MS after the last try: asked again; the old bridge now takes it
    status = 204;
    now = PRESENCE_RELAY_MS;
    await relay.tick();
    expect(posted.length).toBe(4);
    now += 5_000; await relay.tick();
    expect(posted.length).toBe(4);
    // a change goes at once, to both
    inUse = true;
    await relay.tick();
    expect(posted.length).toBe(6);
  });

  it("a refused \"in use\" is tried again on the next 5 s check; a refused \"not in use\" still waits 30 s", async () => {
    let now = 0;
    let inUse = true;
    let fail = true;
    const posted: boolean[] = [];
    const relay = new PresenceRelay({
      inUse: () => inUse,
      targets: () => [{ id: "pc-fictional", url: "http://fictional-bridge", token: "FICTIONAL-token" }],
      waiting: () => [],
      fetch: async (_url, init) => {
        posted.push((JSON.parse(String(init.body)) as { in_use: boolean }).in_use);
        if (fail) throw new Error("FICTIONAL refused");
        return new Response(null, { status: 204 });
      },
      now: () => now,
    });
    await relay.tick();
    expect(posted).toEqual([true]);
    // failed: the next check says it again, without waiting PRESENCE_RELAY_MS
    now += 5_000; await relay.tick();
    expect(posted).toEqual([true, true]);
    // taken: then it waits as any word said does
    fail = false;
    now += 5_000; await relay.tick();
    expect(posted).toEqual([true, true, true]);
    now += 5_000; await relay.tick();
    expect(posted).toEqual([true, true, true]);
    // a failed "not in use" waits PRESENCE_RELAY_MS
    fail = true;
    inUse = false;
    await relay.tick();
    expect(posted).toEqual([true, true, true, false]);
    const failedAt = now;
    for (now += 5_000; now - failedAt < PRESENCE_RELAY_MS; now += 5_000) await relay.tick();
    expect(posted.length).toBe(4);
    now = failedAt + PRESENCE_RELAY_MS; await relay.tick();
    expect(posted).toEqual([true, true, true, false, false]);
  });
});
