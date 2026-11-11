//! The conversation of a Claude session, read from its transcript for the chat
//! view. Claude runs in the tab's terminal as usual; the chat is another way of
//! looking at the same session, so the transcript is the source.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use crate::sessions::{result_text, tool_detail, truncate};

/// On the first read of a long session, only its end is shown.
const FIRST_READ_BYTES: u64 = 4 * 1024 * 1024;
/// How much of a step's input and result the chat keeps.
const STEP_TEXT: usize = 400;

#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct ChatEntry {
    /// "user", "text", "step", "result" or "error".
    pub kind: &'static str,
    /// Unique within the session. A result carries the id of its step.
    pub id: String,
    pub text: String,
    /// Tool name of a step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// A result the tool reported as an error.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub error: bool,
}

#[derive(serde::Serialize)]
pub struct ChatChunk {
    pub entries: Vec<ChatEntry>,
    /// Where the next read starts.
    pub offset: u64,
    /// The file is shorter than the offset asked for, so it was read again
    /// from the start and the caller drops what it had.
    pub reset: bool,
    /// The start of a long session was left out.
    pub clipped: bool,
}

/// Entries written to a transcript after `offset`. Only whole lines are read;
/// a line still being written waits for the next call.
#[tauri::command]
pub fn chat_read(path: String, offset: u64) -> Result<ChatChunk, String> {
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let reset = offset > len;
    let mut start = if reset { 0 } else { offset };
    let clipped = start == 0 && len > FIRST_READ_BYTES;
    if clipped {
        start = len - FIRST_READ_BYTES;
    }
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;

    let mut body = &bytes[..];
    let mut skipped = 0;
    // A clipped read starts mid-line; the partial line is dropped.
    if clipped {
        if let Some(nl) = body.iter().position(|b| *b == b'\n') {
            skipped = nl + 1;
            body = &body[skipped..];
        }
    }
    let complete = body.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let text = String::from_utf8_lossy(&body[..complete]);
    let entries = text.lines().flat_map(entries_of_line).collect();
    Ok(ChatChunk {
        entries,
        offset: start + (skipped + complete) as u64,
        reset,
        clipped,
    })
}

/// A Claude Code command the user typed, such as `/model`, as recorded in
/// the transcript: `<command-name>/model</command-name>` plus its arguments.
fn typed_command(s: &str) -> Option<String> {
    let name = s.split("<command-name>").nth(1)?.split("</command-name>").next()?;
    let args = s
        .split("<command-args>")
        .nth(1)
        .and_then(|a| a.split("</command-args>").next())
        .unwrap_or("")
        .trim();
    Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") })
}

/// Text the user did not write: command output, reminders and the like.
fn is_noise(s: &str) -> bool {
    let t = s.trim_start();
    t.is_empty()
        || t.starts_with("<local-command-")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<task-notification>")
        || t.starts_with("<bash-")
        || t.starts_with("Caveat:")
        || t.starts_with("[Request interrupted")
}

fn entries_of_line(line: &str) -> Vec<ChatEntry> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    // Subagent turns and messages Claude Code adds on its own are not the chat.
    let flag = |k: &str| v.get(k).and_then(|f| f.as_bool()).unwrap_or(false);
    if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") {
        return Vec::new();
    }
    let role = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if role != "user" && role != "assistant" {
        return Vec::new();
    }
    let uuid = v.get("uuid").and_then(|u| u.as_str()).unwrap_or("");
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    if let Some(s) = content.as_str() {
        if role == "user" {
            if let Some(cmd) = typed_command(s) {
                out.push(entry("user", uuid.to_string(), cmd));
            } else if !is_noise(s) {
                out.push(entry("user", uuid.to_string(), s.to_string()));
            }
        }
        return out;
    }

    for (i, block) in content.as_array().into_iter().flatten().enumerate() {
        let id = format!("{uuid}:{i}");
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let t = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if role == "assistant" && !t.trim().is_empty() {
                    out.push(entry("text", id, t.to_string()));
                } else if role == "user" && !is_noise(t) {
                    out.push(entry("user", id, t.to_string()));
                }
            }
            Some("image") if role == "user" => out.push(entry("user", id, "[imagem]".to_string())),
            Some("tool_use") => {
                let tool = block.get("name").and_then(|n| n.as_str()).unwrap_or("ferramenta");
                let input = block.get("input").cloned().unwrap_or_default();
                let step_id = block.get("id").and_then(|s| s.as_str()).unwrap_or(&id).to_string();
                out.push(ChatEntry {
                    tool: Some(tool.to_string()),
                    ..entry("step", step_id, tool_detail(&input, STEP_TEXT))
                });
            }
            Some("tool_result") => {
                let step_id = block.get("tool_use_id").and_then(|s| s.as_str()).unwrap_or(&id).to_string();
                out.push(ChatEntry {
                    error: block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
                    ..entry("result", step_id, truncate(&result_text(block), STEP_TEXT))
                });
            }
            _ => {}
        }
    }
    out
}

fn entry(kind: &'static str, id: String, text: String) -> ChatEntry {
    ChatEntry { kind, id, text, tool: None, error: false }
}

/// What an agent adapter reports once its session is up.
#[derive(serde::Serialize)]
pub struct StartInfo {
    pub session_id: String,
    pub model: String,
    pub models: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
struct EntriesEvent {
    tab_id: String,
    entries: Vec<ChatEntry>,
}

#[derive(Clone, serde::Serialize)]
struct UsageEvent {
    tab_id: String,
    provider: &'static str,
    limits: serde_json::Value,
}

/// Chat entries of an agent that reports them itself (Codex, OpenCode).
pub fn emit_entries(app: &tauri::AppHandle, tab_id: &str, entries: Vec<ChatEntry>) {
    use tauri::Emitter;
    if !entries.is_empty() {
        let _ = app.emit("agent-entries", EntriesEvent { tab_id: tab_id.to_string(), entries });
    }
}

/// Usage an agent reports: rate limits for Codex, cost for OpenCode.
pub fn emit_usage(app: &tauri::AppHandle, tab_id: &str, provider: &'static str, limits: serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit("agent-usage", UsageEvent { tab_id: tab_id.to_string(), provider, limits });
}

/// A hook event made up for an agent without Claude's hooks, so tab state,
/// the queue and notifications follow it the same way.
pub fn agent_hook(app: &tauri::AppHandle, tab_id: &str, provider: &str, name: &str, extra: serde_json::Value) {
    let mut payload = serde_json::json!({ "hook_event_name": name, "provider": provider });
    if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    crate::hooks::emit_hook(app, Some(tab_id.to_string()), payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(line: &str) -> Vec<(&'static str, String)> {
        entries_of_line(line).into_iter().map(|e| (e.kind, e.text)).collect()
    }

    #[test]
    fn a_typed_prompt_is_a_user_entry() {
        let line = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"corrige o teste"}}"#;
        assert_eq!(kinds(line), vec![("user", "corrige o teste".to_string())]);
    }

    #[test]
    fn a_slash_command_shows_as_typed() {
        let line = r#"{"type":"user","uuid":"u1","message":{"content":"<command-name>/model</command-name>\n<command-args>opus</command-args>"}}"#;
        assert_eq!(kinds(line), vec![("user", "/model opus".to_string())]);
    }

    #[test]
    fn command_output_and_meta_lines_are_left_out() {
        let out = r#"{"type":"user","uuid":"u1","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}"#;
        let meta = r#"{"type":"user","isMeta":true,"uuid":"u2","message":{"content":"x"}}"#;
        let side = r#"{"type":"assistant","isSidechain":true,"uuid":"u3","message":{"content":[{"type":"text","text":"x"}]}}"#;
        assert!(kinds(out).is_empty() && kinds(meta).is_empty() && kinds(side).is_empty());
    }

    #[test]
    fn a_tool_call_and_its_result_share_the_id() {
        let call = r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"Vou rodar."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#;
        let result = r#"{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"no such file"}]}}"#;
        let call = entries_of_line(call);
        let result = entries_of_line(result);
        assert_eq!(call[0].kind, "text");
        assert_eq!((call[1].kind, call[1].id.as_str(), call[1].tool.as_deref()), ("step", "t1", Some("Bash")));
        assert_eq!(call[1].text, "ls");
        assert_eq!((result[0].kind, result[0].id.as_str(), result[0].error), ("result", "t1", true));
    }

    #[test]
    fn reads_only_whole_lines_and_resumes_from_the_offset() {
        let dir = std::env::temp_dir().join(format!("shellhive-chat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let first = r#"{"type":"user","uuid":"u1","message":{"content":"um"}}"#;
        std::fs::write(&path, format!("{first}\n{{\"type\":\"user\"")).unwrap();
        let p = path.to_string_lossy().to_string();
        let a = chat_read(p.clone(), 0).unwrap();
        assert_eq!(a.entries.len(), 1);
        assert_eq!(a.offset, first.len() as u64 + 1);
        let second = r#"{"type":"user","uuid":"u2","message":{"content":"dois"}}"#;
        std::fs::write(&path, format!("{first}\n{second}\n")).unwrap();
        let b = chat_read(p.clone(), a.offset).unwrap();
        assert_eq!(b.entries[0].text, "dois");
        assert!(!b.reset);
        let c = chat_read(p, 10_000).unwrap();
        assert!(c.reset && c.entries.len() == 2);
        std::fs::remove_dir_all(dir).ok();
    }
}


