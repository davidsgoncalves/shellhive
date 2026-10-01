import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { reportError } from "../../src/lib/errors";
import type { Diagram } from "./state";

const LABEL = "plugin-mermaid";
const READY = "mermaid-window-ready";
const SHOW = "mermaid-window-show";
const EDITED = "mermaid-diagram-edited";

let current: Diagram | null = null;
let answering = false;

/** Opens the diagram window, or brings it forward showing this diagram. */
export async function openDiagram(diagram: Diagram): Promise<void> {
  current = diagram;
  if (!answering) {
    answering = true;
    // A window that just loaded asks for what it should show.
    void listen(READY, () => current && void emitTo(LABEL, SHOW, current));
  }
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    await emitTo(LABEL, SHOW, diagram);
    await existing.unminimize().catch(() => {});
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow(LABEL, {
    url: "index.html",
    title: diagram.title,
    width: 1000,
    height: 720,
    dragDropEnabled: false,
  });
  win.once("tauri://error", (e) => reportError("window", `diagram window failed: ${JSON.stringify(e.payload)}`));
}

/** In the window: what to show, now and each time the list opens another. */
export function onShow(handler: (d: Diagram) => void): () => void {
  const un = listen<Diagram>(SHOW, (ev) => handler(ev.payload));
  void emit(READY);
  return () => void un.then((u) => u());
}

/** In the window: an edited source, saved by the main window. */
export const sendEdit = (id: string, source: string) => emit(EDITED, { id, source });

export function onEdit(handler: (id: string, source: string) => void): () => void {
  const un = listen<{ id: string; source: string }>(EDITED, (ev) => {
    if (current?.id === ev.payload.id) current = { ...current, source: ev.payload.source };
    handler(ev.payload.id, ev.payload.source);
  });
  return () => void un.then((u) => u());
}
