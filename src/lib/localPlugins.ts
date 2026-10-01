/** A plugin the user made, found in the plugins folder of the data dir. */
export interface LocalPlugin {
  id: string;
  name: string;
  description: string;
  status: "approved" | "pending" | "invalid";
  error: string | null;
  /** Fingerprint of its files; approving ties the approval to it. */
  hash: string;
  dir: string;
  tools: Array<{ name: string; description: string; run: string[] }>;
  panel: { title: string } | null;
  /** A tab of its own in the right column. */
  sidePanel: { title: string } | null;
  menu: Array<{ label: string; tool: string }>;
  schedule: Array<{ tool: string; every: number }>;
  /** Takes a whole pane of the split, like a terminal. */
  view: { title: string } | null;
  window: { title: string; width: number; height: number } | null;
  shortcuts: Array<{ key: string; tool: string | null; open: Surface | null }>;
  permissions: string[];
}

/** The places a plugin can show itself. */
export type Surface = "panel" | "side" | "view" | "window";

/** Panes hold tab ids, or this prefix plus a plugin id for a plugin view. */
export const VIEW_PREFIX = "view:";
export const isView = (id: string | null | undefined): id is string => !!id && id.startsWith(VIEW_PREFIX);
export const viewOf = (pluginId: string) => `${VIEW_PREFIX}${pluginId}`;

/** What a plugin sees of a tab. */
export interface PluginTab {
  id: string;
  title: string;
  cwd: string | null;
  /** The agent session running in it, which survives reopening the tab. */
  sessionId: string | null;
  group: string | null;
  state: string;
}

export function pluginTab(
  tab: { id: string; title: string; cwd: string | null; claudeSessionId: string | null; groupId: string; state: string },
  groups: Array<{ id: string; name: string; fixed?: boolean }>,
): PluginTab {
  const group = groups.find((g) => g.id === tab.groupId && !g.fixed);
  return {
    id: tab.id,
    title: tab.title,
    cwd: tab.cwd,
    sessionId: tab.claudeSessionId,
    group: group?.name ?? null,
    state: tab.state,
  };
}

/** A plugin panel on screen, over the pane of the tab it belongs to. */
export interface PluginPanel {
  plugin: string;
  tabId: string | null;
  /** What a tool sent along with its reply; null when opened from the menu. */
  data: unknown;
}

export const PERMISSION_LABEL: Record<string, string> = {
  tab: "ver a aba e a pasta dela",
  tools: "chamar as próprias ferramentas",
  prompt: "escrever no prompt do agente",
  storage: "guardar dados próprios",
  events: "ver o que o agente faz em cada aba (arquivos e comandos)",
  badge: "escrever uma etiqueta embaixo do nome das abas",
  notify: "mandar notificações do sistema",
  status: "mostrar um indicador na barra de cima",
};
