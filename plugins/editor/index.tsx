import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PluginHost, ShellhivePlugin } from "../../src/lib/plugins";
import { EditorPanel } from "./EditorPanel";
import type { EditorRequest } from "./types";
import manifest from "./plugin.json";
import "./editor.css";

/** Shows the panel the agent asked for through `open_editor`. */
function EditorOverlay({ host }: { host: PluginHost }) {
  const [request, setRequest] = useState<EditorRequest | null>(null);
  useEffect(() => {
    const p = listen<EditorRequest>("editor-request", (ev) => setRequest(ev.payload));
    return () => {
      void p.then((un) => un());
    };
  }, []);
  if (!request) return null;
  return <EditorPanel request={request} onDone={() => setRequest(null)} rect={host.paneRect(request.tab_id)} />;
}

const plugin: ShellhivePlugin = { manifest, Overlay: EditorOverlay };
export default plugin;
