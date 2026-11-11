import type { Tab } from "./types";

export type Provider = NonNullable<Tab["provider"]>;

/** Name shown for each agent that runs outside a terminal. */
export const PROVIDER_NAMES: Record<Provider, string> = { codex: "Codex", opencode: "OpenCode" };

/** The backend commands are `<provider>_start`, `_send`, `_interrupt` and `_stop`. */
export function agentCommand(provider: Provider, action: "start" | "send" | "interrupt" | "stop"): string {
  return `${provider}_${action}`;
}
