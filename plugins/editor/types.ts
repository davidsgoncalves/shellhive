/** Which editor the panel renders. */
export type EditorFormat = "text" | "csv" | "json" | "xml";

/** An editor panel opened by Claude through the app's MCP server. */
export interface EditorRequest {
  id: string;
  tab_id: string | null;
  path: string | null;
  title: string;
  instructions: string | null;
  content: string;
  /** False when Claude is not waiting for the text back. */
  blocking: boolean;
  format: EditorFormat;
}
