import type { ShellhivePlugin } from "../../src/lib/plugins";
import { DiagramPanel } from "./DiagramPanel";
import { problem } from "./render";
import { useDiagram } from "./state";
import manifest from "./plugin.json";
import "./mermaid.css";

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: DiagramPanel,
  tools: {
    // Checked before it is shown, so a syntax error goes back to the agent to fix.
    show_diagram: async (args, { tabId }) => {
      const source = typeof args.source === "string" ? args.source.trim() : "";
      if (!source) return { text: "Informe o código Mermaid em `source`.", isError: true };
      const bad = await problem(source);
      if (bad) return { text: `O diagrama tem erro de sintaxe:\n${bad}`, isError: true };
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Diagrama";
      useDiagram.getState().show({ tabId, title, source });
      return { text: "Diagrama exibido no painel abaixo do terminal." };
    },
  },
};

export default plugin;
