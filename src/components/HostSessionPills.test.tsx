import { describe, expect, test } from "bun:test";
import { onlyPaths } from "./HostSessionPills.tsx";
import type { HostChanges } from "../../shared/host-chats.ts";

describe("an answer's View (ZAC-228)", () => {
  test("cuts the chat's changes to that answer's files, with their own sums", () => {
    const changes: HostChanges = { label: "Changes", status: "ready", added: 40, removed: 7, files: [
      { id: "a", path: "/r/src/build.ts", kind: "edit", added: 28, removed: 3 },
      { id: "b", path: "/r/src/fresh.ts", kind: "create", added: 12, removed: 4 },
    ] };
    const cut = onlyPaths(changes, ["/r/src/build.ts"]);
    expect(cut.files.map((file) => file.id)).toEqual(["a"]);
    expect([cut.added, cut.removed]).toEqual([28, 3]);
    expect(cut.status).toBe("ready");
    expect(changes.files).toHaveLength(2);
  });
});
