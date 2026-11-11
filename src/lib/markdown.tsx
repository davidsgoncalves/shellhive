import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * The Markdown agents write in replies, as React elements: paragraphs,
 * headings, lists, quotes, code blocks, tables and inline code, bold, italic
 * and links. Text never becomes HTML, so a reply cannot inject markup.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))/g;

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}${n++}`;
    const [whole, code, bold, link, italic] = m;
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={k}>{inline(bold.slice(2, -2), `${k}-`)}</strong>);
    else if (italic) out.push(<em key={k}>{inline(italic.slice(1, -1), `${k}-`)}</em>);
    else if (link) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link) ?? [];
      out.push(
        /^https?:\/\//.test(url ?? "") ? (
          <a
            key={k}
            href={url}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(url!);
            }}
          >
            {label}
          </a>
        ) : (
          whole
        ),
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline text with its single line breaks kept. */
function lines(text: string, key: string): ReactNode {
  return text.split("\n").map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {inline(l, `${key}-${i}-`)}
    </Fragment>
  ));
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const rows = text.split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let i = 0;
  const flush = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{lines(para.join("\n"), `p${blocks.length}`)}</p>);
    para = [];
  };

  while (i < rows.length) {
    const row = rows[i];
    const k = `b${blocks.length}`;
    const fence = /^\s*```/.exec(row);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < rows.length && !/^\s*```/.test(rows[i])) body.push(rows[i++]);
      i++;
      blocks.push(
        <pre key={k}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(row);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={k}>{inline(heading[2], k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(row) && /^\s*\|?\s*:?-{2,}/.test(rows[i + 1] ?? "")) {
      flush();
      const head = cells(row);
      i += 2;
      const body: string[][] = [];
      while (i < rows.length && /^\s*\|.*\|\s*$/.test(rows[i])) body.push(cells(rows[i++]));
      blocks.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${k}${ri}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(row);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      const items: string[] = [];
      while (i < rows.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(rows[i]);
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
        // An indented line continues the item above it.
        else if (items.length && /^\s{2,}\S/.test(rows[i])) items[items.length - 1] += `\n${rows[i].trim()}`;
        else break;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={k}>
          {items.map((it, j) => (
            <li key={j}>{lines(it, `${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*>/.test(row)) {
      flush();
      const quote: string[] = [];
      while (i < rows.length && /^\s*>/.test(rows[i])) quote.push(rows[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={k}>{lines(quote.join("\n"), k)}</blockquote>);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(row)) {
      flush();
      blocks.push(<hr key={k} />);
      i++;
      continue;
    }
    if (!row.trim()) flush();
    else para.push(row);
    i++;
  }
  flush();
  return <div className="md">{blocks}</div>;
}
