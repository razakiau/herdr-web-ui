import { describe, expect, it } from "bun:test";

import { handlePresenceRequest, PagePresence } from "./page-presence.ts";

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
