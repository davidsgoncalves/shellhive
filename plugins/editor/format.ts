import type { EditorFormat } from "./types";

/** Human-readable problem with the current text, or null when it is valid. */
export function validate(format: EditorFormat, text: string): string | null {
  if (!text.trim()) return null;
  if (format === "json") {
    try {
      JSON.parse(text);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "JSON inválido";
    }
  }
  if (format === "xml") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const error = doc.querySelector("parsererror");
    return error ? (error.textContent ?? "XML inválido").split("\n")[0] : null;
  }
  return null;
}

/** Re-indents the text, leaving it untouched when it cannot be parsed. */
export function format(kind: EditorFormat, text: string): string {
  if (kind === "json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (kind === "xml") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return text;
    const raw = new XMLSerializer().serializeToString(doc);
    let depth = 0;
    return raw
      .replace(/>\s*</g, "><")
      .replace(/></g, ">\n<")
      .split("\n")
      .map((line) => {
        if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + line;
        if (/^<[^/!?]/.test(line) && !/\/>$/.test(line) && !/<\/[\w:.-]+>$/.test(line)) depth++;
        return out;
      })
      .join("\n");
  }
  return text;
}
