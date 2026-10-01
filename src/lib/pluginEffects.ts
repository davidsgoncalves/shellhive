import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MAIN_LABEL } from "./detach";
import { useStore } from "./store";
import { notify } from "./notify";
import { pluginTab, type LocalPlugin, type PluginTab, type Surface } from "./localPlugins";
import { openPluginWindow } from "./pluginWindow";

/** What a tool reply may ask the app to do, besides answering. */
export interface PluginEffects {
  panel?: unknown;
  /** A badge for the tab the call came from; null removes it. */
  badge?: string | null;
  /** Badges by tab id; null removes one. */
  badges?: Record<string, string | null>;
  notify?: { title?: string; body?: string };
  /** The top bar indicator: text, or { text, title }; null removes it. */
  status?: string | { text?: string; title?: string } | null;
  /** Opens the plugin's view in a pane with this data. */
  view?: unknown;
  /** Opens the plugin's window with this data. */
  window?: unknown;
}

const BADGE_MAX = 60;

/**
 * Applies a reply's effects, each only when the plugin is on and holds what
 * it needs. The backend filters too; this keeps the panel bridge honest.
 */
export function applyEffects(plugin: LocalPlugin, tabId: string | null, effects: PluginEffects | null | undefined): void {
  const s = useStore.getState();
  if (!effects || !s.enabledPlugins.includes(plugin.id) || plugin.status !== "approved") return;
  const allowed = (p: string) => plugin.permissions.includes(p);
  if (effects.panel !== undefined && plugin.panel) {
    s.openPluginPanel({ plugin: plugin.id, tabId, data: effects.panel });
  }
  if (allowed("badge")) {
    const set = (tab: string, text: unknown) =>
      s.setPluginBadge(tab, plugin.id, typeof text === "string" && text.trim() ? text.trim().slice(0, BADGE_MAX) : null);
    if ("badge" in effects && tabId) set(tabId, effects.badge);
    for (const [tab, text] of Object.entries(effects.badges ?? {})) set(tab, text);
  }
  if (allowed("notify") && effects.notify) {
    void notify(String(effects.notify.title ?? plugin.name), String(effects.notify.body ?? ""), true);
  }
  if (allowed("status") && "status" in effects) {
    const st = effects.status;
    const text = typeof st === "string" ? st : st?.text;
    s.setPluginStatus(
      plugin.id,
      text && text.trim() ? { text: text.trim().slice(0, 40), title: typeof st === "object" ? st?.title : undefined } : null,
    );
  }
  if (effects.view !== undefined) openSurface(plugin, "view", tabId, effects.view);
  if (effects.window !== undefined) openSurface(plugin, "window", tabId, effects.window);
}

/** Shows one of a plugin's surfaces, if it has it. */
export function openSurface(plugin: LocalPlugin, surface: Surface, tabId: string | null, data: unknown): void {
  const s = useStore.getState();
  if (!s.enabledPlugins.includes(plugin.id) || plugin.status !== "approved") return;
  if (surface === "panel" && plugin.panel) s.openPluginPanel({ plugin: plugin.id, tabId, data: data ?? null });
  if (surface === "side" && plugin.sidePanel) s.setRightPanelTab(`plugin:${plugin.id}`);
  if (surface === "view" && plugin.view) s.openPluginView(plugin.id, data ?? null);
  if (surface === "window" && plugin.window) void openPluginWindow(plugin, data);
}

export function allTabs(): PluginTab[] {
  const s = useStore.getState();
  return s.tabs.map((t) => pluginTab(t, s.groups));
}

interface RunReply {
  text: string;
  isError: boolean;
  effects: PluginEffects | null;
}

/** Runs one of a plugin's tools from the app, applying what the reply asks. */
export async function runPluginTool(
  plugin: LocalPlugin,
  tool: string,
  tabId: string | null,
  args: Record<string, unknown>,
): Promise<RunReply> {
  const reply = await invoke<RunReply>("local_plugin_run", { id: plugin.id, tool, tabId, args });
  await dispatchEffects(plugin, tabId, reply.effects);
  return reply;
}

/** Applies effects here, or in the main window when called from a plugin's own window, which holds no app state. */
export async function dispatchEffects(plugin: LocalPlugin, tabId: string | null, effects: PluginEffects | null): Promise<void> {
  if (!effects) return;
  if (getCurrentWebviewWindow().label === MAIN_LABEL) applyEffects(plugin, tabId, effects);
  else await emitTo(MAIN_LABEL, "plugin-effects", { plugin: plugin.id, tab_id: tabId, effects });
}
