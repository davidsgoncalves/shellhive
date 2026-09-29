import { useMemo } from "react";
import { detectDelimiter, normalise, parse, stringify } from "./csv";

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** First row is treated as column headers. */
  hasHeader: boolean;
}

/** Spreadsheet view over delimited text, kept in sync with the raw string. */
export function CsvGrid({ value, onChange, hasHeader }: Props) {
  const delimiter = useMemo(() => detectDelimiter(value), [value]);
  const rows = useMemo(() => normalise(parse(value, delimiter).rows), [value, delimiter]);

  const write = (next: string[][]) => onChange(stringify({ rows: normalise(next), delimiter }));

  const setCell = (r: number, c: number, text: string) => {
    const next = rows.map((row) => [...row]);
    next[r][c] = text;
    write(next);
  };

  const addRow = (at?: number) => {
    const width = rows[0]?.length ?? 1;
    const blank = Array(width).fill("");
    const next = rows.map((row) => [...row]);
    next.splice(at ?? next.length, 0, blank);
    write(next);
  };

  const removeRow = (at: number) => {
    if (rows.length <= 1) return;
    write(rows.filter((_, i) => i !== at));
  };

  const addColumn = () => write(rows.map((row) => [...row, ""]));

  const removeColumn = (at: number) => {
    if ((rows[0]?.length ?? 0) <= 1) return;
    write(rows.map((row) => row.filter((_, i) => i !== at)));
  };

  const header = hasHeader ? rows[0] : null;
  const body = hasHeader ? rows.slice(1) : rows;
  const offset = hasHeader ? 1 : 0;
  const width = rows[0]?.length ?? 1;

  return (
    <div className="csv-wrap">
      <table className="csv-grid">
        <thead>
          <tr>
            <th className="corner" />
            {Array.from({ length: width }, (_, c) => (
              <th key={c}>
                {header ? (
                  <input value={header[c] ?? ""} onChange={(e) => setCell(0, c, e.target.value)} />
                ) : (
                  <span className="col-letter">{c + 1}</span>
                )}
                <button className="csv-mini" title="Remover coluna" onClick={() => removeColumn(c)}>
                  ×
                </button>
              </th>
            ))}
            <th className="add">
              <button className="csv-mini" title="Nova coluna" onClick={addColumn}>
                +
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              <td className="row-number">
                {r + 1}
                <button className="csv-mini" title="Remover linha" onClick={() => removeRow(r + offset)}>
                  ×
                </button>
              </td>
              {Array.from({ length: width }, (_, c) => (
                <td key={c}>
                  <input
                    value={row[c] ?? ""}
                    onChange={(e) => setCell(r + offset, c, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.metaKey && r === body.length - 1) addRow();
                    }}
                  />
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <button className="csv-add-row" onClick={() => addRow()}>
        + Nova linha
      </button>
    </div>
  );
}
