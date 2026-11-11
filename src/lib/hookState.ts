import { DEFAULT_TAB_TITLE, type HookEvent, type Tab } from "./types";

const TITLE_MAX = 40;

function autoTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || "Sessão";
}

/**
 * Maps one Claude Code hook event onto the tab it came from.
 * Returns the fields to patch, or null when the event carries no state change.
 */
export function tabPatchFor(tab: Tab, e: HookEvent): Partial<Tab> | null {
  const p = e.payload;
  const name = String(p.hook_event_name ?? "");
  const base: Partial<Tab> = { lastEventAt: e.received_at };
  // Another agent (Codex, OpenCode) keeps its session apart from Claude's,
  // which the tab would otherwise try to resume with `claude --resume`.
  const provider = p.provider === "codex" || p.provider === "opencode" ? p.provider : null;
  const session: Partial<Tab> = {};
  if (provider) {
    if (typeof p.session_id === "string") session.agentSessionId = p.session_id;
  } else {
    if (typeof p.transcript_path === "string") base.transcriptPath = p.transcript_path;
    session.claudeSessionId = typeof p.session_id === "string" ? p.session_id : tab.claudeSessionId;
  }

  switch (name) {
    case "SessionStart":
      // A `codex` typed in a tab's shell makes it a Codex tab in terminal mode.
      if (provider && !tab.provider) Object.assign(session, { provider, claudeSessionId: null, transcriptPath: null });
      return { ...base, ...session, state: "waiting", pendingMessage: null };
    case "UserPromptSubmit": {
      const patch: Partial<Tab> = { ...base, ...session, state: "working", pendingMessage: null };
      // Only fills a tab that has no name yet: a folder name stays until the
      // session's own title arrives from the transcript.
      if (!tab.customTitle && tab.title === DEFAULT_TAB_TITLE && typeof p.prompt === "string" && p.prompt.trim()) {
        patch.title = autoTitle(p.prompt);
      }
      return patch;
    }
    case "PreToolUse":
    case "PostToolUse":
      return { ...base, state: "working" };
    case "PermissionRequest": {
      const tool = typeof p.tool_name === "string" ? p.tool_name : "ferramenta";
      return { ...base, state: "permission", pendingMessage: `Permissão: ${tool}` };
    }
    case "Notification": {
      const type = String(p.notification_type ?? "");
      const message = String(p.message ?? "");
      if (/permission/i.test(type) || /permission/i.test(message)) {
        return { ...base, state: "permission", pendingMessage: message || "Permissão pendente" };
      }
      if (/idle|waiting/i.test(type) || /waiting for your input/i.test(message)) {
        return { ...base, state: "waiting", pendingMessage: message || null };
      }
      return base;
    }
    case "Stop":
      return { ...base, state: "waiting", pendingMessage: null };
    case "SessionEnd":
      return { ...base, state: "shell", pendingMessage: null };
    default:
      return null;
  }
}
