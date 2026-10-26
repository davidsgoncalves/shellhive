import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Command that fixes it, run in a new tab. */
  fix: string | null;
}

export interface McpServer {
  name: string;
  status: "connected" | "auth" | "failed";
}

interface ConnectionsStore {
  checks: Check[] | null;
  mcp: McpServer[] | null;
  mcpError: string | null;
  checking: boolean;
}

/** The last check of Claude Code, the GitHub CLI and the MCP servers. */
export const useConnections = create<ConnectionsStore>()(() => ({
  checks: null,
  mcp: null,
  mcpError: null,
  checking: false,
}));

/** Checks everything again; the MCP list arrives a few seconds after the rest. */
export async function checkConnections(): Promise<void> {
  if (useConnections.getState().checking) return;
  useConnections.setState({ checking: true });
  const mcp = invoke<McpServer[]>("mcp_status")
    .then((list) => useConnections.setState({ mcp: list, mcpError: null }))
    .catch((err) => useConnections.setState({ mcp: null, mcpError: String(err) }));
  const checks = invoke<Check[]>("connections_check").then((list) => useConnections.setState({ checks: list }));
  await Promise.allSettled([mcp, checks]);
  useConnections.setState({ checking: false });
}

/** Opens a tab in the active tab's group and runs a command in its shell. */
export async function runInNewTab(command: string, title: string): Promise<void> {
  const s = useStore.getState();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  const groupId = active?.groupId ?? s.groups.find((g) => !g.fixed)?.id ?? s.groups[0]?.id;
  if (!groupId) return;
  const id = s.addTab(groupId, { title, customTitle: true });
  // The shell starts once the tab's terminal is drawn; typed ahead, the line
  // waits for its first prompt.
  for (let i = 0; i < 50; i++) {
    const ready = await invoke("pty_write", { id, data: "" }).then(
      () => true,
      () => false,
    );
    if (ready) return void (await invoke("pty_write", { id, data: `${command}\r` }));
    await new Promise((r) => setTimeout(r, 100));
  }
}
