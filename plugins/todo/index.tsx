import type { ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { TodoList } from "./TodoList";
import { newTodo, useTodos } from "./state";
import manifest from "./plugin.json";
import "./todo.css";

const plugin: ShellhivePlugin = {
  manifest,
  SideTab: { title: "Todo list", Component: TodoList },
  tools: {
    add_todo: async (args, { tabId }) => {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return { text: "Informe o item em `text`.", isError: true };
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      await useTodos.getState().add(newTodo(text, "claude", tab));
      return { text: "Item adicionado à Todo list." };
    },
  },
};

export default plugin;
