import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostTodo } from "../../shared/host-chats.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { currentTodo, HostTodoBar } from "./HostTodoBar.tsx";

const render = (element: ReactElement): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const todo = (id: string, status: HostTodo["status"]): HostTodo => ({ id, title: `FICTIONAL ${id}`, status });
const SEVEN = [todo("a", "done"), todo("b", "done"), todo("c", "done"), todo("d", "pending"), todo("e", "in_progress"), todo("f", "blocked"), todo("g", "pending")];

describe("HostTodoBar", () => {
  it("names the task in progress before an earlier pending one", () => {
    expect(currentTodo(SEVEN)?.id).toBe("e");
    expect(currentTodo([todo("a", "done"), todo("b", "pending")])?.id).toBe("b");
    expect(currentTodo([todo("a", "done")])).toBeNull();
  });

  it("closed, says how many are done, the current task and how far along it is", () => {
    const html = render(createElement(HostTodoBar, { todos: SEVEN, busy: true }));
    expect(text(html)).toContain("Todos 3/7");
    expect(text(html)).toContain("FICTIONAL e");
    expect(html).toContain("width:42.9%");
    expect(html).not.toContain("todo-bar-list");
  });

  it("is hidden with nothing to do, and once all is done in an idle chat", () => {
    expect(render(createElement(HostTodoBar, { todos: undefined, busy: true }))).toBe("");
    expect(render(createElement(HostTodoBar, { todos: [], busy: true }))).toBe("");
    const done = [todo("a", "done"), todo("b", "done")];
    expect(render(createElement(HostTodoBar, { todos: done, busy: false }))).toBe("");
    expect(text(render(createElement(HostTodoBar, { todos: done, busy: true })))).toContain("Todos 2/2");
  });

  it("open, lists every todo with its state", () => {
    const html = render(createElement(HostTodoBar, { todos: SEVEN, busy: true, defaultOpen: true }));
    expect(html.match(/class="todo-bar-row"/g)?.length).toBe(7);
    for (const status of ["done", "in_progress", "pending", "blocked"]) expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('aria-expanded="true"');
  });
});
