/**
 * App shortcuts per platform. macOS uses Cmd; Linux uses Ctrl+Shift, as its
 * terminals do, since Super is taken by the desktop and plain Ctrl belongs to
 * the shell and to Claude Code. Keys match by physical position (`code`), so
 * Shift and the keyboard layout do not change which key is meant.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

export type Action =
  | "newTab"
  | "reopenTab"
  | "closeTab"
  | "sidebar"
  | "events"
  | "settings"
  | "switcher"
  | "search"
  | "clear"
  | "nextTab"
  | "prevTab"
  | "miniPanel";

interface Combo {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const cmd = (code: string, shift = false): Combo => ({ code, meta: true, shift });
const ctrlShift = (code: string): Combo => ({ code, ctrl: true, shift: true });

const MAC: Record<Action, Combo> = {
  newTab: cmd("KeyT"),
  reopenTab: cmd("KeyT", true),
  closeTab: cmd("KeyW"),
  sidebar: cmd("KeyB"),
  events: cmd("KeyE"),
  settings: cmd("Comma"),
  switcher: cmd("KeyP"),
  search: cmd("KeyF"),
  clear: cmd("KeyK"),
  nextTab: cmd("BracketRight", true),
  prevTab: cmd("BracketLeft", true),
  miniPanel: cmd("KeyM", true),
};

const LINUX: Record<Action, Combo> = {
  newTab: ctrlShift("KeyT"),
  reopenTab: ctrlShift("KeyR"),
  closeTab: ctrlShift("KeyW"),
  sidebar: ctrlShift("KeyB"),
  events: ctrlShift("KeyE"),
  settings: ctrlShift("Comma"),
  switcher: ctrlShift("KeyP"),
  search: ctrlShift("KeyF"),
  clear: ctrlShift("KeyK"),
  nextTab: { code: "PageDown", ctrl: true },
  prevTab: { code: "PageUp", ctrl: true },
  miniPanel: ctrlShift("KeyM"),
};

const TABLE = IS_MAC ? MAC : LINUX;

function matches(e: KeyboardEvent, c: Combo): boolean {
  return (
    e.code === c.code &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    e.shiftKey === !!c.shift &&
    e.altKey === !!c.alt
  );
}

/** The app action a key press stands for, if any. */
export function actionOf(e: KeyboardEvent): Action | null {
  for (const [action, combo] of Object.entries(TABLE) as Array<[Action, Combo]>) {
    if (matches(e, combo)) return action;
  }
  return null;
}

/** Tab number for Cmd+1..9 on macOS and Alt+1..9 on Linux, as in GNOME Terminal. */
export function tabNumberOf(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m) return null;
  const mod = IS_MAC ? e.metaKey && !e.altKey : e.altKey && !e.metaKey;
  return mod && !e.ctrlKey && !e.shiftKey ? Number(m[1]) : null;
}

/** True for any key press the app handles, so the terminal lets it through. */
export function isAppShortcut(e: KeyboardEvent): boolean {
  return actionOf(e) !== null || tabNumberOf(e) !== null || claimed.has(pluginKeyOf(e) ?? "");
}

/**
 * Plugin shortcuts: Cmd+Option on macOS, Ctrl+Alt+Shift elsewhere, plus a
 * letter or digit. No app shortcut uses these. Plain Ctrl+Alt is left alone
 * because AltGr reads as Ctrl+Alt and types characters on many layouts.
 */
export function pluginKeyOf(e: KeyboardEvent): string | null {
  if (!/^(Key[A-Z]|Digit[0-9])$/.test(e.code)) return null;
  if (e.getModifierState?.("AltGraph")) return null;
  const ok = IS_MAC
    ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey;
  return ok ? e.code : null;
}

/** Keys some enabled plugin claims; only these are kept from the terminal. */
const claimed = new Set<string>();
export function setClaimedPluginKeys(keys: string[]): void {
  claimed.clear();
  for (const k of keys) claimed.add(k);
}

/** How a plugin shortcut reads on this platform, e.g. "⌘⌥J". */
export function pluginShortcutLabel(code: string): string {
  const key = code.replace(/^Key|^Digit/, "");
  return IS_MAC ? `⌘⌥${key}` : `Ctrl+Alt+Shift+${key}`;
}

/** Modifier for "open the link" and "send right away": Cmd on macOS, Ctrl on Linux. */
export function primaryMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

const KEY_NAMES: Record<string, string> = {
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Enter: IS_MAC ? "↵" : "Enter",
};

function keyName(code: string): string {
  return KEY_NAMES[code] ?? code.replace(/^Key|^Digit/, "");
}

function label(c: Combo): string {
  const key = keyName(c.code);
  if (IS_MAC) return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${key}`;
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", key].filter(Boolean).join("+");
}

/** How this platform writes the shortcut, e.g. "⌘⇧P" or "Ctrl+Shift+O". */
export function shortcutLabel(action: Action): string {
  return label(TABLE[action]);
}

/** Labels that do not come from the table. */
export const LABELS = {
  click: IS_MAC ? "⌘-clique" : "Ctrl-clique",
  sendNow: IS_MAC ? "⌘↵" : "Ctrl+Enter",
  tabNumber: IS_MAC ? "⌘1 a ⌘9" : "Alt+1 a Alt+9",
};

/**
 * Fills `{action}` placeholders in text written once for both platforms, such
 * as the changelog: `{switcher}`, `{click}`, `{tabNumber}`.
 */
export function withShortcuts(text: string): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name in TABLE) return shortcutLabel(name as Action);
    if (name in LABELS) return LABELS[name as keyof typeof LABELS];
    return whole;
  });
}
