//! What the agent does in each tab, for plugins with the `events` permission:
//! each tool it uses, with the files it touched and the folder it ran in, and
//! where each turn starts and ends. Built from the hook events, in a shape
//! that does not depend on the agent, and kept as a short history so a panel
//! or a tool opened later still sees what happened.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

const KEEP: usize = 2000;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    /// "tool", "turn-start" or "turn-end".
    #[serde(rename = "type")]
    kind: String,
    tab_id: Option<String>,
    /// Milliseconds since the epoch.
    at: u64,
    /// Folder the agent was in.
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// For "tool": the tool's name, like Edit or Bash.
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    /// For "tool": "edit", "read", "command" or "other".
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    /// For "tool": absolute paths of the files it touched.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    paths: Vec<String>,
    /// For a command: the command line.
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
}

static HISTORY: Mutex<VecDeque<AgentEvent>> = Mutex::new(VecDeque::new());

fn absolute(path: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(dir) if Path::new(path).is_relative() => {
            Path::new(dir).join(path).to_string_lossy().to_string()
        }
        _ => path.to_string(),
    }
}

/// Turns a hook payload into an event, or None for hooks plugins do not see.
fn from_hook(tab_id: Option<String>, at: u64, payload: &serde_json::Value) -> Option<AgentEvent> {
    let name = payload.get("hook_event_name")?.as_str()?;
    let cwd = payload
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(str::to_string);
    let mut event = AgentEvent {
        kind: String::new(),
        tab_id,
        at,
        cwd: cwd.clone(),
        tool: None,
        action: None,
        paths: Vec::new(),
        command: None,
    };
    match name {
        "UserPromptSubmit" => event.kind = "turn-start".into(),
        "Stop" => event.kind = "turn-end".into(),
        "PostToolUse" => {
            let tool = payload.get("tool_name")?.as_str()?.to_string();
            let input = payload.get("tool_input").cloned().unwrap_or_default();
            let field = |k: &str| input.get(k).and_then(|v| v.as_str());
            event.kind = "tool".into();
            event.action = Some(
                match tool.as_str() {
                    "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit",
                    "Read" | "Grep" | "Glob" => "read",
                    "Bash" => "command",
                    _ => "other",
                }
                .into(),
            );
            for key in ["file_path", "notebook_path", "path"] {
                if let Some(p) = field(key) {
                    event.paths.push(absolute(p, cwd.as_deref()));
                }
            }
            event.command = field("command").map(str::to_string);
            event.tool = Some(tool);
        }
        _ => return None,
    }
    Some(event)
}

/// Records a hook event and tells the interface, which hands it to the
/// panels allowed to see it.
pub fn record(app: &AppHandle, tab_id: Option<String>, at: u64, payload: &serde_json::Value) {
    let Some(event) = from_hook(tab_id, at, payload) else {
        return;
    };
    {
        let mut history = HISTORY.lock().unwrap();
        history.push_back(event.clone());
        while history.len() > KEEP {
            history.pop_front();
        }
    }
    let _ = app.emit("plugin-event", event);
}

/// The recent events, oldest first.
pub fn recent() -> Vec<AgentEvent> {
    HISTORY.lock().unwrap().iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::from_hook;

    #[test]
    fn an_edit_carries_its_absolute_path() {
        let payload = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Edit",
            "cwd": "/repo/.worktrees/feat",
            "tool_input": { "file_path": "src/main.rs", "old_string": "a", "new_string": "b" }
        });
        let e = from_hook(Some("t1".into()), 1, &payload).unwrap();
        assert_eq!(e.kind, "tool");
        assert_eq!(e.action.as_deref(), Some("edit"));
        assert_eq!(
            e.paths,
            vec!["/repo/.worktrees/feat/src/main.rs".to_string()]
        );
    }

    #[test]
    fn a_command_keeps_its_folder() {
        let payload = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "cwd": "/other-repo",
            "tool_input": { "command": "git status" }
        });
        let e = from_hook(None, 1, &payload).unwrap();
        assert_eq!(e.action.as_deref(), Some("command"));
        assert_eq!(e.cwd.as_deref(), Some("/other-repo"));
        assert_eq!(e.command.as_deref(), Some("git status"));
    }

    #[test]
    fn turns_are_marked_and_other_hooks_ignored() {
        let start = serde_json::json!({ "hook_event_name": "UserPromptSubmit", "prompt": "oi" });
        assert_eq!(from_hook(None, 1, &start).unwrap().kind, "turn-start");
        let other = serde_json::json!({ "hook_event_name": "Notification" });
        assert!(from_hook(None, 1, &other).is_none());
    }
}
