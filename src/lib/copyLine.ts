import type { Terminal } from "@xterm/xterm";

/**
 * A row this close to the right edge was cut by width, not at a space: Claude
 * Code breaks a word longer than its column (a URL, a path) mid-token.
 */
const FULL_ROW_MARGIN = 3;

/**
 * The selection as one line. Claude Code wraps its output itself, so a long
 * command reaches the terminal as several indented rows; this joins them
 * back: a row that ended short of the edge broke at a space and joins with
 * one, a row that filled it broke mid-word and joins without.
 */
export function selectionAsOneLine(term: Terminal): string {
  // Buffer coordinates, 0-based, end column exclusive.
  const range = term.getSelectionPosition();
  if (!range) return "";
  const buf = term.buffer.active;
  let out = "";
  let prevFull = false;
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const from = y === range.start.y ? range.start.x : 0;
    const to = y === range.end.y ? range.end.x : term.cols;
    const text = line.translateToString(false, from, to);
    if (y === range.start.y) out = text.trimEnd();
    // Wrapped by the terminal itself: the row goes on exactly where it was cut.
    else if (line.isWrapped) out += text.trimEnd();
    else {
      const piece = text.trim();
      if (piece) out += prevFull || !out ? piece : ` ${piece}`;
    }
    prevFull = line.translateToString(true).length >= term.cols - FULL_ROW_MARGIN;
  }
  return out.trim();
}

/** Copies what the terminal has selected, as is or as one line. */
export function copySelection(term: Terminal, oneLine: boolean): void {
  const text = oneLine ? selectionAsOneLine(term) : term.getSelection();
  if (text) void navigator.clipboard.writeText(text).catch(console.error);
}
