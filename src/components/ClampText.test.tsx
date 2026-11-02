import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { ClampText } from "./ClampText.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  } });
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

const classed = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
  root.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));

async function clamp(scrollHeight: number): Promise<ReactTestInstance> {
  const node = { scrollHeight, clientHeight: 80 };
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ClampText, { className: "group-summary", children: "FICTIONAL long summary" }) }), { createNodeMock: () => node });
  });
  return renderer!.root;
}

describe("ClampText", () => {
  it("holds a long block to four lines with a Show more that opens and folds it", async () => {
    const root = await clamp(200);
    expect(classed(root, "clamp-text-body")[0]!.props["className"]).toContain("is-clamped");
    const toggle = classed(root, "clamp-text-toggle")[0]!;
    expect(toggle.children).toEqual(["Show more"]);
    await act(async () => { toggle.props["onClick"](); });
    expect(classed(root, "clamp-text-body")[0]!.props["className"]).not.toContain("is-clamped");
    expect(classed(root, "clamp-text-toggle")[0]!.children).toEqual(["Show less"]);
    expect(classed(root, "clamp-text-toggle")[0]!.props["aria-expanded"]).toBe(true);
  });

  it("shows no toggle when the text fits", async () => {
    const root = await clamp(80);
    expect(classed(root, "clamp-text-toggle")).toHaveLength(0);
  });
});
