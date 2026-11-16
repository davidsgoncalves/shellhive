import { useStore } from "./store";
import { PROVIDER_NAMES, type Provider } from "./providers";
import type { DroneAgent, SessionKind } from "./types";

const PROVIDERS = Object.keys(PROVIDER_NAMES) as Provider[];

type Choice = Pick<ReturnType<typeof useStore.getState>, "agentsOff" | "agentsFound">;

/**
 * Codex and OpenCode offered as choices: those the last check found working,
 * minus those the user hid. Before the first check every one is offered.
 */
function offered({ agentsOff, agentsFound }: Choice): Provider[] {
  return PROVIDERS.filter((p) => !agentsOff.includes(p) && (agentsFound === null || agentsFound.includes(p)));
}

/** The agents a new session, drone or flow step can use now: Claude, then the others offered. */
export function availableAgents(): DroneAgent[] {
  return ["claude", ...offered(useStore.getState())];
}

/** The same, following the settings and the checks as they change. */
export function useAvailableAgents(): DroneAgent[] {
  const agentsOff = useStore((s) => s.agentsOff);
  const agentsFound = useStore((s) => s.agentsFound);
  return ["claude", ...offered({ agentsOff, agentsFound })];
}

/** The agent a kind of new session runs, or null for a plain terminal. */
export function agentOfKind(kind: SessionKind): DroneAgent | null {
  if (kind === "terminal") return null;
  if (kind.startsWith("claude")) return "claude";
  return kind.startsWith("codex") ? "codex" : "opencode";
}

/** The agents to choose from, keeping the one already chosen even if it is no longer offered. */
export function useAgentChoices(current?: DroneAgent): DroneAgent[] {
  const list = useAvailableAgents();
  return current && !list.includes(current) ? [...list, current] : list;
}
