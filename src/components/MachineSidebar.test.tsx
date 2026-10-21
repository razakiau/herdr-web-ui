import { describe, expect, it } from "bun:test";
import { hostFolderItems } from "./MachineSidebar.tsx";

const t = ((text: string, values?: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key)) as Parameters<typeof hostFolderItems>[1];
const nothing = (): void => undefined;

describe("an agent host workspace's menu", () => {
  it("folder_menu_is_about_the_folder", () => {
    const items = hostFolderItems({ canStart: true, cwd: "/w/repo", pin: { pinned: false, toggle: nothing }, onNewHostChat: nothing, onFolderChats: nothing, onClose: nothing }, t);
    expect(items.map((item) => item.id)).toEqual(["new-host-chat", "folder-chats", "pin-folder", "close-workspace", "copy-path"]);
    expect(items.find((item) => item.id === "folder-chats")!.label).toBe("Chats in repo…");
    expect(items.some((item) => item.id === "all-agents")).toBe(false);
  });

  it("close_workspace_also_unpins", () => {
    const calls: string[] = [];
    const items = hostFolderItems({ canStart: false, cwd: "/w/repo", pin: { pinned: true, toggle: () => calls.push("unpin") }, onNewHostChat: nothing, onFolderChats: nothing, onClose: () => calls.push("close") }, t);
    expect(items.map((item) => item.id)).toEqual(["folder-chats", "unpin-folder", "close-workspace", "copy-path"]);
    items.find((item) => item.id === "close-workspace")!.run();
    expect(calls).toEqual(["unpin", "close"]);
  });

  it("no_folder_row_offers_no_new_chat_and_no_path", () => {
    // its folder is the host's scratch parent (~/.copilot/chats): a chat started there would land in it
    const items = hostFolderItems({ canStart: true, cwd: "/home/fictional/.copilot/chats", noFolder: true, pin: { pinned: false, toggle: nothing }, onNewHostChat: nothing, onFolderChats: nothing, onClose: nothing }, t);
    expect(items.map((item) => item.id)).toEqual(["folder-chats", "pin-folder", "close-workspace"]);
    expect(items[0]!.label).toBe("Chats in No folder…");
  });
});
