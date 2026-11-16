import type { DiffFile } from "diff2html/lib/types";

/** A line of a diff by its place: block index and line index in the block. */
export const lineKey = (block: number, line: number) => `${block}:${line}`;

/** Every changed line of a file, or of one block. */
export function changedKeys(file: DiffFile, block?: number): string[] {
  const keys: string[] = [];
  file.blocks.forEach((b, bi) => {
    if (block != null && bi !== block) return;
    b.lines.forEach((l, li) => {
      if (l.type !== "context") keys.push(lineKey(bi, li));
    });
  });
  return keys;
}

/** Whether a file's patch can be cut by line: plain edits of a tracked text file. */
export const partialOk = (file: DiffFile) =>
  !file.isNew && !file.isDeleted && !file.isRename && !file.isCopy && !file.isBinary && file.blocks.length > 0;

/**
 * A patch holding only the chosen lines of a diff, for `git apply`. Forward,
 * it goes onto the diff's old side (staging); `reverse` means it is applied
 * with `--reverse` onto the new side (unstaging, discarding). Lines left out
 * keep what that side already has: a removal left out stays as context
 * forward and drops out in reverse, and the opposite for an addition.
 */
export function buildPatch(file: DiffFile, selected: Set<string>, reverse: boolean): string | null {
  const a = file.oldName;
  const b = file.newName;
  const out = [`diff --git a/${a} b/${b}`, `--- a/${a}`, `+++ b/${b}`];
  let shift = 0;
  let any = false;
  file.blocks.forEach((block, bi) => {
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let picked = false;
    block.lines.forEach((line, li) => {
      const text = line.content.slice(1);
      const on = selected.has(lineKey(bi, li));
      if (line.type === "context") {
        body.push(` ${text}`);
        oldCount++;
        newCount++;
      } else if (line.type === "delete") {
        if (on) {
          body.push(`-${text}`);
          oldCount++;
          picked = true;
        } else if (!reverse) {
          body.push(` ${text}`);
          oldCount++;
          newCount++;
        }
      } else if (on) {
        body.push(`+${text}`);
        newCount++;
        picked = true;
      } else if (reverse) {
        body.push(` ${text}`);
        oldCount++;
        newCount++;
      }
    });
    if (!picked) return;
    any = true;
    // The side the patch lands on keeps every line, so its numbers are the
    // diff's own; the other side moves by what earlier hunks left out.
    const oldStart = reverse ? block.newStartLine - shift : block.oldStartLine;
    const newStart = reverse ? block.newStartLine : block.oldStartLine + shift;
    const at = (start: number, count: number) => (count === 0 ? Math.max(start - 1, 0) : start);
    out.push(`@@ -${at(oldStart, oldCount)},${oldCount} +${at(newStart, newCount)},${newCount} @@`, ...body);
    shift += newCount - oldCount;
  });
  return any ? `${out.join("\n")}\n` : null;
}

/** The chosen lines as a quote, with their numbers, for a comment. */
export function quoteLines(file: DiffFile, selected: Set<string>): { range: string; quote: string } {
  const nums: number[] = [];
  const lines: string[] = [];
  file.blocks.forEach((block, bi) =>
    block.lines.forEach((line, li) => {
      if (!selected.has(lineKey(bi, li))) return;
      const n = line.newNumber ?? line.oldNumber;
      if (n != null) nums.push(n);
      lines.push(line.content);
    }),
  );
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return { range: nums.length === 0 ? "" : lo === hi ? `linha ${lo}` : `linhas ${lo}-${hi}`, quote: lines.join("\n") };
}
