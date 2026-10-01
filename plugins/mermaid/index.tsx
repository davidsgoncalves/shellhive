import { useEffect } from "react";
import type { ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { DiagramList } from "./DiagramList";
import { DiagramWindow } from "./DiagramWindow";
import { problem } from "./render";
import { useDiagrams } from "./state";
import { onEdit, openDiagram } from "./window";
import manifest from "./plugin.json";
import "./mermaid.css";

/** Saves the edits made in the diagram window; mounted in the main window. */
function SaveEdits() {
  useEffect(() => onEdit((id, source) => void useDiagrams.getState().update(id, source)), []);
  return null;
}

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: SaveEdits,
  SideTab: { title: "Diagramas", Component: DiagramList },
  Window: DiagramWindow,
  tools: {
    // Drawn once before it is kept, so any error goes back to the agent to fix.
    show_diagram: async (args, { tabId }) => {
      const source = typeof args.source === "string" ? args.source.trim() : "";
      if (!source) return { text: "Informe o código Mermaid em `source`.", isError: true };
      const bad = await problem(source);
      if (bad) return { text: `O diagrama tem erro de sintaxe:\n${bad}`, isError: true };
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Diagrama";
      const s = useStore.getState();
      const diagram = {
        id: crypto.randomUUID(),
        tabId,
        tabTitle: s.tabs.find((t) => t.id === tabId)?.title ?? "",
        title,
        source,
        at: Date.now(),
      };
      await useDiagrams.getState().add(diagram);
      // Opens only for the session on screen; any other just adds to the list.
      const onScreen = !!tabId && (s.activeTabId === tabId || s.detached.includes(tabId));
      if (onScreen) await openDiagram(diagram);
      return {
        text: onScreen
          ? "Diagrama aberto numa janela e salvo na aba Diagramas."
          : "Diagrama salvo na aba Diagramas; o usuário abre de lá.",
      };
    },
  },
};

export default plugin;
