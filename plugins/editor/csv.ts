/** Delimiters tried when a file does not declare one. */
const CANDIDATES = [",", ";", "\t", "|"];

export interface CsvData {
  rows: string[][];
  delimiter: string;
}

/** Picks the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (sample.length === 0) return ",";
  let best = ",";
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = sample.map((l) => parse(l, d).rows[0]?.length ?? 0);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = consistent * 10 + max;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Parses delimited text, honouring quoted fields with embedded breaks. */
export function parse(text: string, delimiter: string): CsvData {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, delimiter };
}

function quote(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || /[\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function stringify({ rows, delimiter }: CsvData): string {
  return rows.map((r) => r.map((c) => quote(c, delimiter)).join(delimiter)).join("\n");
}

/** Pads every row to the widest one, so the grid stays rectangular. */
export function normalise(rows: string[][]): string[][] {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return rows.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill("")]));
}
