import { invoke } from "@tauri-apps/api/core";
import type { IDisposable, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { IS_MAC, primaryMod } from "./shortcuts";

/**
 * Measures emoji such as ❓ and 🔵 as two cells, as Claude Code does. With
 * xterm's default Unicode 6 widths they take one cell, so the rest of the
 * line lands one column off and partial redraws leave stray letters behind.
 */
export function fixEmojiWidth(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
}

/** Paths with a folder part or a `:line` suffix, as Claude prints them. */
const PATH_RE = /(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+(?::\d+){0,2}|[\w.@-]+\.[A-Za-z]\w{0,5}:\d+(?::\d+)?/g;

function open(target: string, cwd: string | null): void {
  void invoke("link_open", { target, cwd }).catch((err) => console.warn("link_open failed", err));
}

/**
 * Cmd+click (Ctrl+click on Linux) opens web URLs, OSC 8 links (which Claude Code prints for files)
 * and plain file paths that exist, relative paths resolved from the tab's folder.
 *
 * Off macOS, an app that tracks the mouse also gets the Ctrl+click and may open the link itself,
 * as Claude Code's fullscreen mode does, so the link is left to it. Cmd never reaches the app, so
 * on macOS the click is always ours.
 */
export function attachLinks(term: Terminal, getCwd: () => string | null): IDisposable {
  const follow = (e: MouseEvent, target: string) => {
    if (!primaryMod(e)) return;
    if (!IS_MAC && term.modes.mouseTrackingMode !== "none") return;
    open(target, getCwd());
  };

  term.options.linkHandler = { allowNonHttpProtocols: true, activate: follow };
  const web = new WebLinksAddon(follow);
  term.loadAddon(web);

  const known = new Map<string, boolean>();
  const exists = async (target: string): Promise<boolean> => {
    const key = `${getCwd() ?? ""}\0${target}`;
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const found = await invoke<boolean>("path_exists", { target, cwd: getCwd() }).catch(() => false);
    known.set(key, found);
    return found;
  };

  const provider = term.registerLinkProvider({
    provideLinks: (y, callback) => {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      // Pieces of URLs match too, but never exist on disk, so they drop out.
      const candidates = [...line.matchAll(PATH_RE)];
      if (candidates.length === 0) return callback(undefined);
      void Promise.all(candidates.map((m) => exists(m[0]))).then((flags) => {
        const links = candidates
          .filter((_, i) => flags[i])
          .map((m) => ({
            text: m[0],
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: follow,
          }));
        callback(links.length ? links : undefined);
      });
    },
  });

  return {
    dispose: () => {
      provider.dispose();
      web.dispose();
    },
  };
}

function quote(path: string): string {
  return /[\s'"\\$`]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

/**
 * Pastes the paths of files dropped on a terminal. Finder drops carry the real
 * path when the webview exposes it; otherwise the contents are saved to a
 * temporary file and that path is used, which is enough for Claude to read an
 * image or a document.
 */
export async function pasteDroppedFiles(tabId: string, data: DataTransfer): Promise<void> {
  const fromUris = (data.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("file://"))
    .map((l) => decodeURIComponent(l.slice("file://".length).replace(/^localhost/, "")));

  let paths = fromUris;
  if (paths.length === 0) {
    paths = await Promise.all(
      [...data.files].map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return invoke<string>("drop_save", bytes, { headers: { "x-file-name": encodeURIComponent(file.name) } });
      }),
    );
  }
  if (paths.length === 0) return;
  const text = paths.map(quote).join(" ") + " ";
  await invoke("pty_write", { id: tabId, data: `\x1b[200~${text}\x1b[201~` });
}

/** True when a drag carries a tab from the tab list. */
export function carriesTab(data: DataTransfer): boolean {
  return [...data.types].includes("text/tab-id");
}

/** True when a drag carries a saved session from the sessions list. */
export function carriesSession(data: DataTransfer): boolean {
  return [...data.types].includes("application/x-claude-session");
}

/** True when a drag carries files from outside the app, not a tab. */
export function carriesFiles(data: DataTransfer): boolean {
  return [...data.types].includes("Files");
}

const IS_LINUX = typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent);

/**
 * WebKitGTK with an input method (IBus, as on ABNT2 layouts) leaves typed text
 * in xterm's hidden textarea. Keys then arrive as composition keys and xterm
 * resends what is left there, so "palhaço" comes out as "palhaççç". Emptying
 * the textarea once xterm has read each input keeps it from being resent.
 */
export function fixLinuxInput(term: Terminal): IDisposable {
  const ta = term.textarea;
  if (!IS_LINUX || !ta) return { dispose: () => {} };
  let composing = false;
  // Runs after xterm's own zero-delay reads of the textarea.
  const clearSoon = () =>
    setTimeout(() => {
      if (!composing) ta.value = "";
    }, 10);
  const onStart = () => {
    composing = true;
  };
  const onEnd = () => {
    composing = false;
    clearSoon();
  };
  const onInput = (e: Event) => {
    if (!(e as InputEvent).isComposing) clearSoon();
  };
  ta.addEventListener("compositionstart", onStart);
  ta.addEventListener("compositionend", onEnd);
  ta.addEventListener("input", onInput);
  return {
    dispose: () => {
      ta.removeEventListener("compositionstart", onStart);
      ta.removeEventListener("compositionend", onEnd);
      ta.removeEventListener("input", onInput);
    },
  };
}
