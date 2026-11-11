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

/** Claude models offered by id, with the name Claude Code shows. Update when a model comes out. */
export const CLAUDE_MODELS: [string, string][] = [
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-fable-5-2", "Fable 5.2"],
];
