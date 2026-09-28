import type { ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/700.css";
import { GROUP_COLORS } from "./types";
import { IS_MAC } from "./shortcuts";
import { reportError } from "./errors";

export type ThemeId = "classic" | "glass" | "glow" | "glow-amber";

interface ThemeSpec {
  label: string;
  terminal: ITheme;
  fontFamily: string;
  lineHeight: number;
  /** Colours offered for groups; a new group takes the next one. */
  groupColors: string[];
  /** Whether the main window shows the system's blur behind it (macOS only). */
  vibrancy: boolean;
  /** Floating layers over a backdrop, the layout Glass and the Glows share. */
  layers: boolean;
}

const SYSTEM_MONO = "Menlo, Monaco, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Courier New', monospace";

/** Terminal colours of the layered themes, from the Claude Design mock. */
const LAYERED_TERMINAL: ITheme = {
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
};

const LAYERED_GROUPS = ["#6ee7a8", "#4fd1c5", "#b69cff", "#ff8fc7", "#cfe06a", "#e2c9a0"];

export const THEMES: Record<ThemeId, ThemeSpec> = {
  classic: {
    label: "Clássico",
    terminal: { background: "#0f1115", foreground: "#d6d8de", cursor: "#d97757" },
    fontFamily: SYSTEM_MONO,
    lineHeight: 1,
    groupColors: GROUP_COLORS,
    vibrancy: false,
    layers: false,
  },
  glass: {
    label: "Glass",
    terminal: LAYERED_TERMINAL,
    fontFamily: `'Geist Mono', ${SYSTEM_MONO}`,
    // 13px text on 18px lines.
    lineHeight: 18 / 13,
    groupColors: LAYERED_GROUPS,
    vibrancy: true,
    layers: true,
  },
  glow: {
    label: "Glow",
    terminal: LAYERED_TERMINAL,
    fontFamily: `'Geist Mono', ${SYSTEM_MONO}`,
    lineHeight: 18 / 13,
    groupColors: LAYERED_GROUPS,
    vibrancy: false,
    layers: true,
  },
  "glow-amber": {
    label: "Glow Âmbar",
    terminal: LAYERED_TERMINAL,
    fontFamily: `'Geist Mono', ${SYSTEM_MONO}`,
    lineHeight: 18 / 13,
    groupColors: LAYERED_GROUPS,
    vibrancy: false,
    layers: true,
  },
};

/** The user's terminal font; null fields follow the theme. */
export interface TerminalFont {
  family: string | null;
  size: number | null;
  lineHeight: number | null;
  letterSpacing: number | null;
}

export const THEME_FONT: TerminalFont = { family: null, size: null, lineHeight: null, letterSpacing: null };
export const DEFAULT_FONT_SIZE = 13;

const STORAGE_KEY = "shellhive-look";

let current: ThemeId = "classic";
let font: TerminalFont = THEME_FONT;

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && value in THEMES;
}

export function currentTheme(): ThemeSpec {
  return THEMES[current];
}

/** Font options after the user's choices, falling back to the theme's. */
export function resolvedFont(): Pick<ITerminalOptions, "fontFamily" | "fontSize" | "lineHeight" | "letterSpacing"> {
  const t = currentTheme();
  const family = font.family?.replace(/['"]/g, "").trim();
  return {
    fontFamily: family ? `'${family}', ${SYSTEM_MONO}` : t.fontFamily,
    fontSize: font.size ?? DEFAULT_FONT_SIZE,
    lineHeight: font.lineHeight ?? t.lineHeight,
    letterSpacing: font.letterSpacing ?? 0,
  };
}

/** Options for a new terminal, in the current theme. */
export function terminalOptions(): ITerminalOptions {
  const t = currentTheme();
  return {
    ...resolvedFont(),
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: t.terminal,
  };
}

/**
 * Live terminals in this window, restyled when the look changes. `refit`
 * fits the terminal to its pane and tells the pty its new size.
 */
const live = new Map<Terminal, () => void>();

export function trackTerminal(term: Terminal, refit: () => void): () => void {
  live.set(term, refit);
  return () => live.delete(term);
}

async function restyleTerminals(): Promise<void> {
  const t = currentTheme();
  const f = resolvedFont();
  // xterm measures the font when it is set; measuring a font still loading
  // would space every cell with the fallback's width.
  await document.fonts.load(`${f.fontSize}px ${f.fontFamily}`).catch(() => {});
  for (const [term, refit] of live) {
    term.options.theme = t.terminal;
    Object.assign(term.options, f);
    refit();
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

/** Applies a theme and terminal font to this window. */
export function applyLook(id: ThemeId, terminalFont: TerminalFont): void {
  const themeChanged = id !== current || document.documentElement.dataset.theme !== id;
  current = id;
  font = terminalFont;
  document.documentElement.dataset.theme = id;
  if (THEMES[id].layers) document.documentElement.dataset.layers = "on";
  else delete document.documentElement.dataset.layers;
  void restyleTerminals();
  if (themeChanged) void setVibrancy(THEMES[id].vibrancy);
}

/**
 * Detached windows and the mini panel never load the app state, so the main
 * window shares the theme through storage, which every window of the app sees.
 */
export function shareLook(id: ThemeId, terminalFont: TerminalFont): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: id, font: terminalFont }));
  } catch {
    // Storage off only leaves secondary windows in the default theme.
  }
}

/** For secondary windows: take the shared look now and follow its changes. */
export function followSharedLook(): void {
  const read = (): [ThemeId, TerminalFont] => {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return [isThemeId(v.theme) ? v.theme : "classic", { ...THEME_FONT, ...v.font }];
    } catch {
      return ["classic", THEME_FONT];
    }
  };
  applyLook(...read());
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) applyLook(...read());
  });
}
