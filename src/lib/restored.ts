/**
 * Tabs whose next shell should run `claude --resume`.
 *
 * A tab is added when it is restored from disk at startup, when it is opened
 * from the session list, and when a closed tab is reopened. It is never added
 * because a running session reported its id, which would make a live session
 * try to resume itself.
 */
const pending = new Set<string>();

export function markPendingResume(ids: string[]): void {
  ids.forEach((id) => pending.add(id));
}

/** True the first time it is asked about a marked tab, false after. */
export function takePendingResume(id: string): boolean {
  return pending.delete(id);
}

/** First prompts for new tabs, sent as `claude "<prompt>"` when the shell starts. */
const prompts = new Map<string, string>();

export function markPendingPrompt(id: string, prompt: string): void {
  prompts.set(id, prompt);
}

export function takePendingPrompt(id: string): string | null {
  const prompt = prompts.get(id) ?? null;
  prompts.delete(id);
  return prompt;
}
