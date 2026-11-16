import { invoke } from "@tauri-apps/api/core";

export interface GitInfo {
  branch: string;
  added: number;
  removed: number;
  files: number;
}

export interface FileStatus {
  path: string;
  from?: string;
  /** Index column of `git status`. */
  staged: string;
  /** Working tree column of `git status`. */
  unstaged: string;
  conflict: boolean;
  untracked: boolean;
}

export interface WorktreeInfo {
  root: string;
  repo: string;
  main: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  operation: string | null;
  files: FileStatus[];
  defaultBase: string | null;
}

export interface TurnTree {
  root: string;
  from: string;
  to: string | null;
}

export interface Turn {
  id: string;
  tabId: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  trees: TurnTree[];
  undone: boolean;
}

export interface Conflict {
  merged: string;
  current: string;
  hasMarkers: boolean;
}

export interface WorktreeCheck {
  exists: boolean;
  branch: string | null;
  dirty: number;
  unpushed: number;
}

export type DiffKind = "unstaged" | "staged" | "base" | "range";

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const api = {
  info: (cwd: string) => invoke<GitInfo | null>("git_info", { cwd }),
  tabWorktrees: (tabId: string, extra: string[]) =>
    invoke<{ root: string; lastAt: number }[]>("git_tab_worktrees", { tabId, extra }),
  worktree: (root: string) => invoke<WorktreeInfo>("git_worktree_info", { root }),
  refs: (root: string) => invoke<string[]>("git_refs", { root }),
  diff: (root: string, kind: DiffKind, opts: { base?: string; to?: string; path?: string } = {}) =>
    invoke<string>("git_diff", { root, kind, base: opts.base ?? null, to: opts.to ?? null, path: opts.path ?? null }),
  apply: (root: string, patch: string, cached: boolean, reverse: boolean) =>
    invoke<void>("git_apply", { root, patch, cached, reverse }),
  files: (root: string, action: "stage" | "unstage" | "discard", paths: string[]) =>
    invoke<void>("git_files", { root, action, paths }),
  commit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  push: (root: string) => invoke<string>("git_push", { root }),
  conflict: (root: string, path: string) => invoke<Conflict>("git_conflict", { root, path }),
  resolve: (root: string, path: string, content: string | null) => invoke<void>("git_resolve", { root, path, content }),
  worktreeAdd: (repo: string, name: string, base: string | null) =>
    invoke<string>("git_worktree_add", { repo, name, base }),
  worktreeCheck: (root: string) => invoke<WorktreeCheck>("git_worktree_check", { root }),
  worktreeRemove: (repo: string, root: string, branch: string | null, deleteBranch: boolean) =>
    invoke<void>("git_worktree_remove", { repo, root, branch, deleteBranch }),
  turns: (tabId: string) => invoke<Turn[]>("git_turns", { tabId }),
  undoTurn: (turnId: string) => invoke<{ restored: string[]; skipped: string[] }>("git_undo_turn", { turnId }),
  agentLines: (root: string) => invoke<Record<string, string[]>>("git_agent_lines", { root }),
};

export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
