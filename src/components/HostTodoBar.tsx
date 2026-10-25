import { Check, ChevronDown, Circle, CircleDot, ListChecks, TriangleAlert, type LucideIcon } from "lucide-react";

import type { HostTodo } from "../../shared/host-chats.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { useT } from "../lib/i18n.ts";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import "./HostTodoBar.css";

const ICON: Record<HostTodo["status"], LucideIcon> = { done: Check, in_progress: CircleDot, pending: Circle, blocked: TriangleAlert };

/** What the agent is on: the first todo in progress, else the first still to do. */
export function currentTodo(todos: readonly HostTodo[]): HostTodo | null {
  return todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending") ?? null;
}

/**
 * VS Code's todo list above the input (chat.todoListWidget), drawn as a tab tucked under the
 * composer's top edge (the Composer's `tray`) so it reads as part of it: closed, how many are done,
 * a short meter and the task the agent is on; open, every todo with its state. Gone when there is none,
 * and once all are done and the chat is idle.
 */
export function HostTodoBar({ todos, busy, defaultOpen = false }: { todos: readonly HostTodo[] | undefined; busy: boolean; defaultOpen?: boolean }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle("host-todos", null);
  const open = chosen ?? defaultOpen;
  if (todos === undefined || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "done").length;
  if (done === todos.length && !busy) return null;
  const current = currentTodo(todos);
  const share = `${Math.round((done / todos.length) * 1000) / 10}%`;
  return <section className="todo-bar">
    <button type="button" className="todo-bar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ListChecks className="todo-bar-icon" aria-hidden="true" />
      <span className="todo-bar-title">{t("Todos {done}/{total}", { done, total: todos.length })}</span>
      <span className="todo-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done}>
        <span className="todo-bar-fill" style={{ width: share }} />
      </span>
      {current !== null && <span className="todo-bar-current">{current.title}</span>}
      <ChevronDown className="todo-bar-caret" aria-hidden="true" />
    </button>
    <AnimatedHeight open={open}>
      {open && <ol className="todo-bar-list">
        {todos.map((todo) => {
          const Icon = ICON[todo.status];
          return <li key={todo.id} className="todo-bar-row" data-status={todo.status}>
            <Icon className="todo-bar-row-icon" aria-hidden="true" />
            <span className="todo-bar-row-title">{todo.title}</span>
          </li>;
        })}
      </ol>}
    </AnimatedHeight>
  </section>;
}
