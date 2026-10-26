import type { ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { RailIcon } from "../../src/components/RailIcon";
import { TodoList } from "./TodoList";
import { newTodo, useTodos } from "./state";
import manifest from "./plugin.json";
import "./todo.css";

const plugin: ShellhivePlugin = {
  manifest,
  SideTab: {
    title: "Todo list",
    Component: TodoList,
    icon: <RailIcon><path d="M4 7l1.5 1.5L8 6M4 13l1.5 1.5L8 12M4 19l1.5 1.5L8 18M11 7h9M11 13h9M11 19h9" /></RailIcon>,
  },
  tools: {
    add_todo: async (args, { tabId }) => {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return { text: "Informe o item em `text`.", isError: true };
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      await useTodos.getState().add(newTodo(text, "claude", tab));
      return { text: "Item adicionado à Todo list." };
    },
    list_todos: async () => {
      await useTodos.getState().load();
      const open = useTodos
        .getState()
        .todos.filter((t) => !t.done)
        .map((t) => ({ id: t.id, text: t.text, from: t.tabTitle || null, folder: t.cwd, at: new Date(t.at).toISOString() }));
      return { text: open.length ? JSON.stringify(open, null, 2) : "A Todo list está vazia." };
    },
    // Done, not deleted: the item leaves the list and stays stored.
    remove_todo: async (args) => {
      await useTodos.getState().load();
      const item = useTodos.getState().todos.find((t) => t.id === args.id && !t.done);
      if (!item) return { text: "Item não encontrado entre os abertos; veja os ids em list_todos.", isError: true };
      await useTodos.getState().toggle(item.id);
      return { text: `Item tirado da lista: ${item.text}` };
    },
  },
};

export default plugin;
