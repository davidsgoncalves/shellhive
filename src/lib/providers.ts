import type { SessionKind, Tab } from "./types";

export type Provider = NonNullable<Tab["provider"]>;

/** Name shown for each agent that runs outside a terminal. */
export const PROVIDER_NAMES: Record<Provider, string> = { codex: "Codex", opencode: "OpenCode" };

/** The backend commands are `<provider>_start`, `_send`, `_interrupt` and `_stop`. */
export function agentCommand(provider: Provider, action: "start" | "send" | "interrupt" | "stop"): string {
  return `${provider}_${action}`;
}

/** The choices for a new tab, in menu order. */
export const SESSION_KINDS: [SessionKind, string][] = [
  ["terminal", "Terminal"],
  ["claude-chat", "Claude em chat"],
  ["claude-terminal", "Claude no terminal"],
  ["codex", "Codex em chat"],
  ["codex-terminal", "Codex no terminal"],
  ["opencode", "OpenCode em chat"],
  ["opencode-terminal", "OpenCode no terminal"],
];

/** Model aliases Claude Code takes in `--model` and `/model`. */
export const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
