import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../../src/lib/types";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** Who wrote it: the user in the panel, or Claude through add_todo. */
  by: "user" | "claude";
  /** Milliseconds since the epoch. */
  at: number;
  cwd: string | null;
  tabId: string | null;
  /** The tab's title when it was added, for when the tab is gone. */
  tabTitle: string;
  sessionId: string | null;
}

const PLUGIN_ID = "todo";

interface TodoStore {
  todos: Todo[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (t: Todo) => Promise<void>;
  toggle: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const save = (todos: Todo[]) =>
  invoke("plugin_storage_set", { id: PLUGIN_ID, value: { todos } }).catch((err) =>
    console.error("todo save failed", err),
  );

/** Every item on the list, newest first, kept across restarts. */
export const useTodos = create<TodoStore>()((set, get) => {
  const change = async (next: (list: Todo[]) => Todo[]) => {
    await get().load();
    const todos = next(get().todos);
    set({ todos });
    await save(todos);
  };
  let loading: Promise<void> | null = null;
  return {
    todos: [],
    loaded: false,
    load: () =>
      (loading ??= invoke<{ todos?: Todo[] } | null>("plugin_storage_get", { id: PLUGIN_ID })
        .then((stored) => set({ todos: Array.isArray(stored?.todos) ? stored.todos : [], loaded: true }))
        .catch(() => set({ loaded: true }))),
    add: (t) => change((list) => [t, ...list]),
    toggle: (id) => change((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t))),
    remove: (id) => change((list) => list.filter((t) => t.id !== id)),
  };
});

/** A new item, tied to the tab it came from and the session running there. */
export function newTodo(text: string, by: Todo["by"], tab: Tab | undefined): Todo {
  return {
    id: crypto.randomUUID(),
    text,
    done: false,
    by,
    at: Date.now(),
    cwd: tab?.cwd ?? null,
    tabId: tab?.id ?? null,
    tabTitle: tab?.title ?? "",
    sessionId: tab?.claudeSessionId ?? null,
  };
}
