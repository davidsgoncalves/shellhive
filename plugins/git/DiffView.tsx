import { useLayoutEffect, useMemo, useRef } from "react";
import { html } from "diff2html";
import type { DiffFile } from "diff2html/lib/types";
import "diff2html/bundles/css/diff2html.min.css";
import { lineKey } from "./patch";

export type Layout = "line-by-line" | "side-by-side";

interface Props {
  file: DiffFile;
  layout: Layout;
  selected: Set<string>;
  /** Text of lines the agent added in this file. */
  agent: Set<string>;
  /** A line clicked; `extend` when Shift was held. */
  onLine: (key: string, extend: boolean) => void;
  /** A block header clicked. */
  onBlock: (block: number) => void;
}

/** Index of each line by side and number, for finding a clicked row. */
function indexLines(file: DiffFile) {
  const byOld = new Map<number, string>();
  const byNew = new Map<number, string>();
  file.blocks.forEach((b, bi) =>
    b.lines.forEach((l, li) => {
      const key = lineKey(bi, li);
      if (l.oldNumber != null) byOld.set(l.oldNumber, key);
      if (l.newNumber != null) byNew.set(l.newNumber, key);
    }),
  );
  return { byOld, byNew };
}

const num = (el: Element | null | undefined) => {
  const n = parseInt(el?.textContent?.trim() ?? "", 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Finds the line a table row shows. In the unified layout the number cell
 * holds both numbers; side by side, the first table is the old side.
 */
function rowKey(row: HTMLTableRowElement, index: ReturnType<typeof indexLines>, layout: Layout): string | null {
  const cell = row.cells[0];
  if (!cell || cell.classList.contains("d2h-info")) return null;
  if (layout === "line-by-line") {
    const n2 = num(cell.querySelector(".line-num2"));
    if (n2 != null) return index.byNew.get(n2) ?? null;
    const n1 = num(cell.querySelector(".line-num1"));
    return n1 != null ? (index.byOld.get(n1) ?? null) : null;
  }
  const side = row.closest(".d2h-file-side-diff");
  const first = side?.parentElement?.firstElementChild === side;
  const n = num(cell);
  if (n == null) return null;
  return (first ? index.byOld : index.byNew).get(n) ?? null;
}

/** One file's diff, drawn by diff2html, with lines that can be picked. */
export function DiffView({ file, layout, selected, agent, onLine, onBlock }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const markup = useMemo(
    () => html([file], { drawFileList: false, outputFormat: layout, matching: "lines", colorScheme: "light" as never }),
    [file, layout],
  );
  const index = useMemo(() => indexLines(file), [file]);

  // Tags each row with its line, then marks picked and agent lines.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const lines = new Map<string, string>();
    file.blocks.forEach((b, bi) => b.lines.forEach((l, li) => lines.set(lineKey(bi, li), l.content)));
    for (const table of root.querySelectorAll("tbody")) {
      let block = -1;
      for (const row of table.rows) {
        if (row.cells[0]?.classList.contains("d2h-info")) {
          block++;
          row.dataset.block = String(block);
          row.classList.add("git-block-row");
          continue;
        }
        const key = rowKey(row, index, layout);
        if (!key) continue;
        row.dataset.key = key;
        const content = lines.get(key) ?? "";
        row.classList.toggle("git-picked", selected.has(key));
        row.classList.toggle("git-agent", content.startsWith("+") && agent.has(content.slice(1)));
      }
    }
  }, [markup, index, layout, selected, agent, file]);

  return (
    <div
      ref={box}
      className="git-diff"
      onMouseDown={(e) => {
        // Shift-click picks a range instead of selecting text.
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        const row = (e.target as HTMLElement).closest("tr");
        if (!row) return;
        if (row.dataset.block) return onBlock(Number(row.dataset.block));
        // Only the number column picks, so the code can still be selected and copied.
        if (row.dataset.key && (e.target as HTMLElement).closest("td") === row.cells[0]) onLine(row.dataset.key, e.shiftKey);
      }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
