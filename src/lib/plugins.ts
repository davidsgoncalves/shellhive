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
  /**
   * The pane showing a tab, or null while the tab is not on screen. A panel
   * belongs to the tab that asked for it: while null it stays hidden, and
   * mounted, so it comes back as it was.
   */
  paneRect(tabId: string | null): PaneRect | null;
}

/** A plugin's `plugin.json`. The backend reads the same file. */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  agentContext?: string;
  tools?: unknown[];
}

/** What a tool handler sends back to the agent. */
export interface ToolReply {
  text: string;
  isError?: boolean;
}

/** An agent tool answered by the plugin's interface. */
export type ToolHandler = (args: Record<string, unknown>, call: { tabId: string | null }) => Promise<ToolReply>;

export interface ShellhivePlugin {
  manifest: PluginManifest;
  /** Drawn over the terminals area while the plugin is on. */
  Overlay?: ComponentType<{ host: PluginHost }>;
  /** Handlers of the manifest's tools that run in the interface, by name. */
  tools?: Record<string, ToolHandler>;
}

// Official plugins live in plugins/<id>/ and are bundled with the app.
const found = import.meta.glob<{ default: ShellhivePlugin }>("../../plugins/*/index.tsx", { eager: true });

export const PLUGINS: ShellhivePlugin[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
