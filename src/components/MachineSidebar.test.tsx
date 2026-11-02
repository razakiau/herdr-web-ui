import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { hostFolderItems, MachineSidebar } from "./MachineSidebar.tsx";

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

describe("the sidebar's search field", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "requestAnimationFrame"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], userAgent: "" } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 0 });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), requestAnimationFrame: () => 0, cancelAnimationFrame() {},
      setTimeout, clearTimeout, innerWidth: 390, innerHeight: 844, location: { href: "/", search: "" }, history: { state: null, pushState() {}, replaceState() {}, back() {} },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
      activeElement: null, body: {}, visibilityState: "visible",
    } });
    globalThis.fetch = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    globalThis.fetch = realFetch;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });
  const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
    node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
  const nodeMock = () => ({ focus() {}, contains: () => false, closest: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), scrollWidth: 0, clientWidth: 0, scrollLeft: 0, style: {} });

  it("an empty field's cross closes the search (Close search), the magnifier back in the head", async () => {
    const machines = [{ id: "local", name: "Mac", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }] as unknown as Parameters<typeof MachineSidebar>[0]["machines"];
    const props = { machines, selectedMachineId: "local", selectedPaneId: null, actions: new Proxy({}, { get: () => nothing }) as never,
      activity: { seqs: () => new Map(), status: () => undefined } as never, onSelect: nothing, onNew: nothing, onSetup: nothing };
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(MachineSidebar, props) }), { createNodeMock: nodeMock }); });
    const root = renderer!.root;
    await act(async () => { classed(root, "sidebar-search-toggle")[0]!.props["onClick"](); });
    expect(classed(root, "sidebar-filter")).toHaveLength(1);
    expect(root.findByType("input").props["value"]).toBe("");
    const cross = classed(root, "sidebar-filter-clear")[0]!;
    expect(cross.props["aria-label"]).toBe("Close search");
    await act(async () => { cross.props["onClick"]({ currentTarget: { parentElement: null } }); });
    expect(classed(root, "sidebar-filter")).toHaveLength(0);
    expect(classed(root, "sidebar-search-toggle")).toHaveLength(1);
  });
});
