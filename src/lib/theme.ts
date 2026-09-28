import type { ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/700.css";
import { GROUP_COLORS } from "./types";
import { IS_MAC } from "./shortcuts";
import { reportError } from "./errors";

export type ThemeId = "classic" | "glass";

interface ThemeSpec {
  label: string;
  terminal: ITheme;
  fontFamily: string;
  lineHeight: number;
  /** Colours offered for groups; a new group takes the next one. */
  groupColors: string[];
  /** Whether the main window shows the system's blur behind it (macOS only). */
  vibrancy: boolean;
}

const SYSTEM_MONO = "Menlo, Monaco, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Courier New', monospace";

export const THEMES: Record<ThemeId, ThemeSpec> = {
  classic: {
    label: "Clássico",
    terminal: { background: "#0f1115", foreground: "#d6d8de", cursor: "#d97757" },
    fontFamily: SYSTEM_MONO,
    lineHeight: 1,
    groupColors: GROUP_COLORS,
    vibrancy: false,
  },
  glass: {
    label: "Glass",
    terminal: {
      background: "#0d1016",
      foreground: "#e6e9f0",
      cursor: "#ffffff",
      cursorAccent: "#0d1016",
      selectionBackground: "#2a3350",
      black: "#7d8597",
      red: "#ff6e7a",
      green: "#6ee7a8",
      yellow: "#ffd166",
      blue: "#7ab8ff",
      magenta: "#d49bff",
      cyan: "#5fd8e0",
      white: "#c9cfdb",
      brightBlack: "#9aa2b3",
      brightRed: "#ff9aa3",
      brightGreen: "#9ff0c4",
      brightYellow: "#ffe199",
      brightBlue: "#a6d0ff",
      brightMagenta: "#e5bfff",
      brightCyan: "#93e8ee",
      brightWhite: "#f5f7fb",
    },
    fontFamily: `'Geist Mono', ${SYSTEM_MONO}`,
    // 13px text on 18px lines.
    lineHeight: 18 / 13,
    groupColors: ["#6ee7a8", "#4fd1c5", "#b69cff", "#ff8fc7", "#cfe06a", "#e2c9a0"],
    vibrancy: true,
  },
};

const STORAGE_KEY = "shellhive-theme";

let current: ThemeId = "classic";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && value in THEMES;
}

export function currentTheme(): ThemeSpec {
  return THEMES[current];
}

/** Options for a new terminal, in the current theme. */
export function terminalOptions(): ITerminalOptions {
  const t = currentTheme();
  return {
    fontFamily: t.fontFamily,
    fontSize: 13,
    lineHeight: t.lineHeight,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: t.terminal,
  };
}

/** Live terminals in this window, restyled when the theme changes. */
const live = new Map<Terminal, FitAddon>();

export function trackTerminal(term: Terminal, fit: FitAddon): () => void {
  live.set(term, fit);
  return () => live.delete(term);
}

async function restyleTerminals(): Promise<void> {
  const t = currentTheme();
  // xterm measures the font when it is set; measuring a font still loading
  // would space every cell with the fallback's width.
  await document.fonts.load(`13px ${t.fontFamily}`).catch(() => {});
  for (const [term, fit] of live) {
    term.options.theme = t.terminal;
    term.options.fontFamily = t.fontFamily;
    term.options.lineHeight = t.lineHeight;
    fit.fit();
  }
}

/**
 * Shows the system blur behind the main window. The window is created
 * transparent on macOS only, so elsewhere the theme keeps a solid backdrop.
 */
async function setVibrancy(on: boolean): Promise<void> {
  const root = document.documentElement;
  if (!IS_MAC) return;
  try {
    const win = getCurrentWindow();
    if (win.label !== "main") return;
    if (on) {
      await win.setEffects({ effects: [Effect.HudWindow] });
      root.dataset.vibrancy = "on";
    } else {
      await win.clearEffects();
      delete root.dataset.vibrancy;
    }
  } catch (err) {
    delete root.dataset.vibrancy;
    reportError("theme", err);
  }
}

/** Applies a theme to this window: colours, fonts, terminals and backdrop. */
export function applyTheme(id: ThemeId): void {
  current = id;
  document.documentElement.dataset.theme = id;
  void restyleTerminals();
  void setVibrancy(THEMES[id].vibrancy);
}

/**
 * Detached windows and the mini panel never load the app state, so the main
 * window shares the theme through storage, which every window of the app sees.
 */
export function shareTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage off only leaves secondary windows in the default theme.
  }
}

/** For secondary windows: take the shared theme now and follow its changes. */
export function followSharedTheme(): void {
  const read = (): ThemeId => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return isThemeId(v) ? v : "classic";
    } catch {
      return "classic";
    }
  };
  applyTheme(read());
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) applyTheme(read());
  });
}
