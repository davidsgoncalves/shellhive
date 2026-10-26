import { useEffect } from "react";
import type { PluginHost, ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { RailIcon } from "../../src/components/RailIcon";
import { DiagramList } from "./DiagramList";
import { DiagramView } from "./DiagramView";
import { problem } from "./render";
import { useDiagrams } from "./state";
import { useShown } from "./shown";
import manifest from "./plugin.json";
import "./mermaid.css";

/** The diagrams open in place of a tab's terminal. */
function DiagramOverlay({ host }: { host: PluginHost }) {
  const { shown, hide } = useShown();
  // Bringing up a session shows its terminal, even when it was already active.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.pickedTab && s.pickedTab !== prev.pickedTab) useShown.getState().hide(s.pickedTab.id);
      }),
    [],
  );
  return Object.entries(shown).map(([tabId, diagram]) => (
    <DiagramView key={tabId} shown={diagram} rect={host.paneRect(tabId)} onClose={() => hide(tabId)} />
  ));
}

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: DiagramOverlay,
  SideTab: {
    title: "Diagramas",
    Component: DiagramList,
    icon: <RailIcon><rect x="3" y="3" width="7" height="5" rx="1" /><rect x="14" y="16" width="7" height="5" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /><path d="M6.5 8v8M6.5 12h11v4" /></RailIcon>,
  },
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
      // Opens only over a session on screen in this window; any other just adds to the list.
      const onScreen = !!tabId && s.panes.includes(tabId) && !s.detached.includes(tabId);
      if (onScreen) useShown.getState().show(tabId, diagram);
      return {
        text: onScreen
          ? "Diagrama aberto no lugar do terminal e salvo na aba Diagramas."
          : "Diagrama salvo na aba Diagramas; o usuário abre de lá.",
      };
    },
  },
};

export default plugin;
