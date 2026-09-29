import type { ComponentType } from "react";

/** Where a pane sits in the terminals area, in percentages. */
export interface PaneRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** What the app hands a plugin's interface. */
export interface PluginHost {
  /** The pane showing a tab, or the first pane when the tab is not on screen. */
  paneRect(tabId: string | null): PaneRect;
}

/** A plugin's `plugin.json`. The backend reads the same file. */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  defaultEnabled?: boolean;
  agentContext?: string;
  tools?: unknown[];
}

export interface ShellhivePlugin {
  manifest: PluginManifest;
  /** Drawn over the terminals area while the plugin is on. */
  Overlay?: ComponentType<{ host: PluginHost }>;
}

// Official plugins live in plugins/<id>/ and are bundled with the app.
const found = import.meta.glob<{ default: ShellhivePlugin }>("../../plugins/*/index.tsx", { eager: true });

export const PLUGINS: ShellhivePlugin[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

export function defaultEnabledPlugins(): string[] {
  return PLUGINS.filter((p) => p.manifest.defaultEnabled).map((p) => p.manifest.id);
}
