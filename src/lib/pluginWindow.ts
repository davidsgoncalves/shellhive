import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { LocalPlugin } from "./localPlugins";
import { reportError } from "./errors";

/** Events between the main window and a plugin's own window. */
export const PLUGIN_WINDOW_READY = "plugin-window-ready";
export const PLUGIN_WINDOW_DATA = "plugin-window-data";

const PREFIX = "plugin-";
export const pluginWindowLabel = (id: string) => `${PREFIX}${id}`;
export const pluginOfWindow = (label: string) => (label.startsWith(PREFIX) ? label.slice(PREFIX.length) : null);

/** Last data handed to each plugin window, sent again when it reloads. */
const lastData = new Map<string, unknown>();
let listening = false;

/** Opens the plugin's window, or brings it forward with new data. */
export async function openPluginWindow(plugin: LocalPlugin, data: unknown): Promise<void> {
  if (!plugin.window) return;
  lastData.set(plugin.id, data ?? null);
  if (!listening) {
    listening = true;
    void listen<string>(PLUGIN_WINDOW_READY, (ev) =>
      void emitTo(pluginWindowLabel(ev.payload), PLUGIN_WINDOW_DATA, lastData.get(ev.payload) ?? null),
    );
  }
  const label = pluginWindowLabel(plugin.id);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    await emitTo(label, PLUGIN_WINDOW_DATA, data ?? null);
    return;
  }
  const win = new WebviewWindow(label, {
    url: "index.html",
    title: plugin.window.title,
    width: plugin.window.width,
    height: plugin.window.height,
    dragDropEnabled: false,
  });
  win.once("tauri://error", (e) => reportError("window", `plugin window failed: ${JSON.stringify(e.payload)}`));
}
