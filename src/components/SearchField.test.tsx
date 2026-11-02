import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { SearchField, type SearchFieldProps } from "./SearchField.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} } });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));

async function field(props: Partial<SearchFieldProps> = {}, initial = ""): Promise<ReactTestInstance> {
  function Host() {
    const [value, setValue] = useState(initial);
    return createElement(SearchField, { value, onValue: setValue, label: "Search things", placeholder: "Search things", ...props });
  }
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(Host) })); });
  return renderer!.root;
}
const clear = (root: ReactTestInstance) => classed(root, "search-field-clear")[0];
const focusMock = () => { const input = { focused: 0, focus() { input.focused += 1; } }; return input; };

describe("SearchField: the app's one search field", () => {
  it("is a magnifier, then a search input named by its label, in one shell; no cross while it is empty", async () => {
    const root = await field({ className: "where-it-sits" });
    const shell = classed(root, "search-field")[0]!;
    expect(shell.props["className"]).toContain("where-it-sits");
    const input = root.findByType("input");
    expect(input.props["type"]).toBe("search");
    expect(input.props["aria-label"]).toBe("Search things");
    expect(classed(root, "search-field-icon")).toHaveLength(1);
    expect(clear(root)).toBeUndefined();
  });

  it("shows a cross once there are words; it clears them and puts the caret back", async () => {
    const root = await field();
    await act(async () => { root.findByType("input").props["onChange"]({ target: { value: "zac" } }); });
    expect(root.findByType("input").props["value"]).toBe("zac");
    expect(clear(root)!.props["aria-label"]).toBe("Clear search");
    const input = focusMock();
    await act(async () => { clear(root)!.props["onClick"]({ currentTarget: { parentElement: { querySelector: () => input } } }); });
    expect(root.findByType("input").props["value"]).toBe("");
    expect(input.focused).toBe(1);
    expect(clear(root)).toBeUndefined();
  });

  it("keeps the cross on an empty field when it can dismiss (the sidebar's Close search), and runs that", async () => {
    let dismissed = 0;
    const root = await field({ onDismiss: () => { dismissed += 1; }, dismissLabel: "Close search", clearLabel: "Clear filter" });
    expect(clear(root)!.props["aria-label"]).toBe("Close search");
    await act(async () => { clear(root)!.props["onClick"]({ currentTarget: { parentElement: null } }); });
    expect(dismissed).toBe(1);
    await act(async () => { root.findByType("input").props["onChange"]({ target: { value: "a" } }); });
    expect(clear(root)!.props["aria-label"]).toBe("Clear filter");
  });

  it("draws no cross of its own in a bar whose Close sits beside it", async () => {
    const root = await field({ clearable: false }, "words");
    expect(clear(root)).toBeUndefined();
  });

  it("passes the input's own attributes through (placeholder, autofocus, a hook class)", async () => {
    const root = await field({ inputClassName: "sidebar-filter-input", autoFocus: true, maxLength: 9 });
    const input = root.findByType("input");
    expect(input.props["className"]).toBe("search-field-input sidebar-filter-input");
    expect(input.props["placeholder"]).toBe("Search things");
    expect(input.props["autoFocus"]).toBe(true);
    expect(input.props["maxLength"]).toBe(9);
  });
});
