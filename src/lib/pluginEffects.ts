import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { notify } from "./notify";
import { pluginTab, type LocalPlugin, type PluginTab } from "./localPlugins";

/** What a tool reply may ask the app to do, besides answering. */
export interface PluginEffects {
  panel?: unknown;
  /** A badge for the tab the call came from; null removes it. */
  badge?: string | null;
  /** Badges by tab id; null removes one. */
  badges?: Record<string, string | null>;
  notify?: { title?: string; body?: string };
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
  applyEffects(plugin, tabId, reply.effects);
  return reply;
}
