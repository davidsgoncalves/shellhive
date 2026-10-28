export type TabState = "dormant" | "shell" | "working" | "permission" | "waiting";

export interface Tab {
  id: string;
  groupId: string;
  title: string;
  /** True once the user renamed the tab; auto-titles stop overwriting it. */
  customTitle: boolean;
  cwd: string | null;
  claudeSessionId: string | null;
  state: TabState;
  lastEventAt: number | null;
  pendingMessage: string | null;
  /** Path of the Claude transcript, used to read the session title. */
  transcriptPath: string | null;
  /** Last `/rename` value seen in the transcript, to detect a new rename. */
  claudeTitle: string | null;
  /** Opened to create worker bees with Claude; only it gets the bee tools. */
  beeCreator?: boolean;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  /** Shown before the name, in place of the color dot. */
  emoji?: string | null;
  collapsed: boolean;
  /** Optional base folder; new sessions in this group open there directly. */
  folderId: string | null;
  /** The always-present catch-all group, which cannot be removed. */
  fixed?: boolean;
  /** Kept out of the tab list until restored; its sessions keep running. */
  hidden?: boolean;
  /** Requests approved without asking for tabs in this group. */
  allowRules?: PermissionRule[];
  /** How `claude` starts in the group's tabs; unset fields leave Claude's own defaults. */
  launch?: GroupLaunch;
}

export interface GroupLaunch {
  model?: string | null;
  permissionMode?: string | null;
  /** Sent as the first prompt when a new tab opens in the group. */
  prompt?: string | null;
}

/** A group closed with its sessions kept, to reopen them all later. */
export interface ArchivedGroup {
  id: string;
  name: string;
  color: string;
  emoji?: string | null;
  folderId: string | null;
  launch?: GroupLaunch;
  allowRules?: PermissionRule[];
  archivedAt: number;
  sessions: Array<{ id: string; cwd: string | null; title: string }>;
}

/** A tool approved for a whole group; a shell command matches only exactly. */
export interface PermissionRule {
  tool: string;
  command: string | null;
}

/** Catch-all group, so a session never needs a group created first. */
export const UNGROUPED_ID = "ungrouped";
/**
 * Group of the tabs worker bees run in. No group has this id, so the lists
 * that go by group never show them.
 */
export const BEE_GROUP_ID = "worker-bee";

/** True for a tab a worker bee runs in, kept out of sight. */
export const isBeeTab = (t: { groupId: string }) => t.groupId === BEE_GROUP_ID;

export type BeeTrigger =
  | { kind: "manual" }
  | { kind: "interval"; minutes: number }
  /** Days are 0 (Sunday) to 6; time is "HH:MM". */
  | { kind: "schedule"; days: number[]; time: string }
  /**
   * Something that happened in a tab or in the app. Session events can be
   * limited to one group; `cooldown` is the least time, in minutes, between
   * two runs it starts.
   */
  | { kind: "event"; event: BeeEvent; groupId: string | null; cooldown: number };

/** What starts an event bee: Claude Code hooks from the tabs, or the app itself. */
export type BeeEvent =
  /** A session finished answering (Stop). */
  | { on: "stop" }
  /** A session ended (SessionEnd). */
  | { on: "sessionEnd" }
  /** A tool was used (PostToolUse); `match` is text its input must contain. */
  | { on: "tool"; tool: string; match: string | null }
  /** Claude stopped to wait for the user (Notification). */
  | { on: "notification" }
  /** A subagent finished (SubagentStop). */
  | { on: "subagentStop" }
  /** Another bee finished a run. */
  | { on: "beeDone"; beeId: string }
  /** Usage of a window went past a percentage. */
  | { on: "usage"; window: "session" | "weekly"; percent: number }
  /** The app was opened. */
  | { on: "appOpen" };

/** A routine Claude runs in the background, in a hidden tab. */
export interface Bee {
  id: string;
  name: string;
  /** The whole prompt the bee runs: a template the user filled in, or their own text. */
  instructions: string;
  /** The template it started from, if any. */
  templateId?: string;
  trigger: BeeTrigger;
  /** What a run missed while the app was closed does on launch. */
  missed: "run" | "skip";
  enabled: boolean;
  createdAt: number;
  /** Start of the last run, or of the last missed one skipped. */
  lastRunAt: number | null;
}

export interface BeeRun {
  id: string;
  beeId: string;
  /** The hidden tab while it runs. */
  tabId: string | null;
  sessionId: string | null;
  /** Where it ran; runs from before the bees' own folder have none and ran in the home folder. */
  cwd?: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error";
  /** Claude's last reply, or what went wrong. */
  summary: string | null;
  /** Opened in a normal tab while running, so it stays open at the end. */
  revealed?: boolean;
}

export const UNGROUPED_NAME = "Sem grupo";
export const UNGROUPED_COLOR = "#6b7280";

/** Where the tab list lives. */
export type Layout = "sidebar" | "topbar";

/** Which edge of the window holds the limits and split bar. */
export type BarPosition = "top" | "bottom";

/** A shell command Claude asked the user to run, shown as a button. */
export interface CommandSuggestion {
  id: string;
  tab_id: string | null;
  command: string;
  reason: string | null;
  /** Clicked while Claude was busy: runs as soon as the session waits. */
  queued?: boolean;
}

/** A subagent a tab's Claude session started and has not finished. */
export interface Subagent {
  /** Tool use id of the call that started it. */
  id: string;
  description: string;
  type: string | null;
  background: boolean;
  startedAt: number;
}

/** Branch and pending changes of a tab's folder. */
export interface GitInfo {
  branch: string;
  added: number;
  removed: number;
  files: number;
}

/** How strongly a group's colour tints its background. */
export type GroupTint = "subtle" | "strong" | "none";

/** How a long tab name fits in the sidebar. */
export type TitleWrap = "truncate" | "wrap";

/**
 * What the × on a tab does: end the session and send it to the history, free
 * the pane it is shown in, or end its terminal and keep the tab to resume.
 */
export type CloseAction = "archive" | "pane" | "sleep";

/** Thickness of the group-coloured frame around the terminal, in pixels. */
export const BORDER_OPTIONS = [
  { value: 0, label: "Sem borda" },
  { value: 1, label: "Fina" },
  { value: 2, label: "Média" },
  { value: 4, label: "Grossa" },
] as const;

export interface HookEvent {
  received_at: number;
  tab_id: string | null;
  payload: Record<string, unknown>;
}

export interface HookSetup {
  hooks_json: string;
  forward_sh: string;
  port: number;
}

export const GROUP_COLORS = ["#d97757", "#4caf7d", "#5b8def", "#c9a227", "#b56bd6", "#3fb8b0"];

export const STATE_LABEL: Record<TabState, string> = {
  dormant: "fechada",
  shell: "shell",
  working: "trabalhando",
  permission: "aguardando permissão",
  waiting: "aguardando você",
};

export interface RateWindow {
  used_percentage: number;
  resets_at: number;
}

/** Subset of the Claude Code statusline JSON the app consumes. */
export interface StatusPayload {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: {
    used_percentage?: number | null;
    context_window_size?: number;
    total_input_tokens?: number;
  };
  rate_limits?: {
    five_hour?: RateWindow;
    seven_day?: RateWindow;
    spend_limit?: RateWindow;
  };
}

export interface StatusEnvelope {
  received_at: number;
  tab_id: string | null;
  payload: StatusPayload;
}

export interface RateLimits {
  five_hour?: RateWindow;
  seven_day?: RateWindow;
  spend_limit?: RateWindow;
  receivedAt: number;
  fromTabId: string | null;
}

export interface PermissionPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  permission_mode?: string;
  permission_rule_decision?: string | null;
}

export interface PermissionRequest {
  id: string;
  received_at: number;
  tab_id: string | null;
  payload: PermissionPayload;
  expires_in: number;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface SessionTitles {
  custom: string | null;
  ai: string | null;
}

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  project: string;
  modified_at: number;
  size_bytes: number;
  first_prompt: string | null;
  git_branch: string | null;
  titles: SessionTitles;
}

export interface SessionMatch {
  id: string;
  snippet: string;
}

/** Placeholder title for a tab opened without a folder name. */
export const DEFAULT_TAB_TITLE = "Nova sessão";

/** Minutes a tab may sit waiting before the watchdog flags it. */
export const WATCHDOG_MINUTES = 5;

/** A project folder registered in settings; new sessions open in one of these. */
export interface Folder {
  id: string;
  name: string;
  path: string;
}

export interface PathCheck {
  exists: boolean;
  is_dir: boolean;
  name: string | null;
  expanded: string;
}

/** One question Claude asked through its question tool, shown in the queue. */
export interface QuestionItem {
  id: string;
  tab_id: string | null;
  received_at: number;
  /** Tool use id, used to drop the item once Claude moves on. */
  tool_use_id: string | null;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

/** How the terminal area is split. */
export type SplitMode = "single" | "cols2" | "rows2" | "cols3" | "grid4";

export const SPLIT_MODES: Array<{ mode: SplitMode; label: string; panes: number; glyph: string }> = [
  { mode: "single", label: "Um terminal", panes: 1, glyph: "▭" },
  { mode: "cols2", label: "Dois lado a lado", panes: 2, glyph: "◫" },
  { mode: "rows2", label: "Dois em linha", panes: 2, glyph: "⊟" },
  { mode: "cols3", label: "Três lado a lado", panes: 3, glyph: "⦀" },
  { mode: "grid4", label: "Quatro em grade", panes: 4, glyph: "⊞" },
];

export function paneCount(mode: SplitMode): number {
  return SPLIT_MODES.find((s) => s.mode === mode)?.panes ?? 1;
}

/** Position of one pane, in percentages, for absolute placement. */
export function paneRect(mode: SplitMode, index: number): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const full = { left: "0%", top: "0%", width: "100%", height: "100%" };
  switch (mode) {
    case "cols2":
      return { ...full, left: `${index * 50}%`, width: "50%" };
    case "rows2":
      return { ...full, top: `${index * 50}%`, height: "50%" };
    case "cols3":
      return { ...full, left: `${(index * 100) / 3}%`, width: `${100 / 3}%` };
    case "grid4":
      return {
        left: index % 2 === 0 ? "0%" : "50%",
        top: index < 2 ? "0%" : "50%",
        width: "50%",
        height: "50%",
      };
    default:
      return full;
  }
}
