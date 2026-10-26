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
  },
};

export default plugin;
