//! Official plugins, bundled with the app. Each one lives in `plugins/<id>/`
//! at the repo root with a `plugin.json` manifest; the backend reads the
//! manifests at build time and offers the agent tools of the enabled ones on
//! the MCP server. The interface side of each plugin is bundled by the
//! frontend from the same folder.

pub mod editor;

use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

const MANIFESTS: &[&str] = &[
    include_str!("../../../plugins/editor/plugin.json"),
    include_str!("../../../plugins/mermaid/plugin.json"),
];

/// How long a tool answered by a plugin's interface may take.
const FRONTEND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    id: String,
    /// On until the user turns it off.
    #[serde(default)]
    default_enabled: bool,
    /// Sentence added to what the agent is told when a session starts.
    #[serde(default)]
    agent_context: Option<String>,
    /// MCP tool definitions, as the server lists them.
    #[serde(default)]
    tools: Vec<serde_json::Value>,
}

fn manifests() -> &'static [Manifest] {
    static PARSED: OnceLock<Vec<Manifest>> = OnceLock::new();
    PARSED.get_or_init(|| {
        MANIFESTS
            .iter()
            .filter_map(|m| serde_json::from_str(m).ok())
            .collect()
    })
}

/// Enabled plugin ids, as last sent by the interface. None until then, when
/// each plugin's default applies.
static ENABLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn is_enabled(m: &Manifest) -> bool {
    match &*ENABLED.lock().unwrap() {
        Some(ids) => ids.contains(&m.id),
        None => m.default_enabled,
    }
}

fn tool_name(tool: &serde_json::Value) -> Option<&str> {
    tool.get("name").and_then(|n| n.as_str())
}

/// Agent tools of the enabled plugins.
pub fn tools() -> Vec<serde_json::Value> {
    manifests()
        .iter()
        .filter(|m| is_enabled(m))
        .flat_map(|m| m.tools.iter().cloned())
        .collect()
}

/// The enabled plugin that offers a tool, if any.
pub fn tool_owner(name: &str) -> Option<String> {
    manifests()
        .iter()
        .filter(|m| is_enabled(m))
        .find(|m| m.tools.iter().any(|t| tool_name(t) == Some(name)))
        .map(|m| m.id.clone())
}

/// What the enabled plugins add to the agent's session context.
pub fn agent_context() -> Vec<String> {
    manifests()
        .iter()
        .filter(|m| is_enabled(m))
        .filter_map(|m| m.agent_context.clone())
        .collect()
}

/// Every tool any plugin offers, enabled or not, for the pre-allowed list.
pub fn all_tool_names() -> Vec<String> {
    manifests()
        .iter()
        .flat_map(|m| m.tools.iter().filter_map(tool_name).map(str::to_string))
        .collect()
}

#[derive(Clone, serde::Serialize)]
struct ToolCall {
    call_id: String,
    plugin: String,
    tool: String,
    tab_id: Option<String>,
    args: serde_json::Value,
}

/// Replies of plugin interfaces to tool calls, by call id.
static REPLIES: Mutex<Option<HashMap<String, serde_json::Value>>> = Mutex::new(None);
static REPLIED: Condvar = Condvar::new();

/// Runs a tool whose handler lives in the plugin's interface: the call goes
/// to the frontend as `plugin-tool-call`, and the reply comes back through
/// `plugin_tool_result` as an MCP tool result.
pub fn call_frontend(
    app: &AppHandle,
    plugin: &str,
    tool: &str,
    tab_id: Option<String>,
    args: &serde_json::Value,
) -> serde_json::Value {
    let call_id = format!("pc-{}", crate::hooks::next_public_id());
    let _ = app.emit(
        "plugin-tool-call",
        ToolCall {
            call_id: call_id.clone(),
            plugin: plugin.to_string(),
            tool: tool.to_string(),
            tab_id,
            args: args.clone(),
        },
    );
    let deadline = Instant::now() + FRONTEND_TIMEOUT;
    let mut guard = REPLIES.lock().unwrap();
    loop {
        if let Some(reply) = guard.as_mut().and_then(|r| r.remove(&call_id)) {
            return reply;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return crate::mcp::text_result(
                format!("O plugin {plugin} não respondeu a {tool}."),
                true,
            );
        }
        guard = REPLIED.wait_timeout(guard, left).unwrap().0;
    }
}

/// A plugin interface's reply to a tool call.
#[tauri::command]
pub fn plugin_tool_result(call_id: String, text: String, is_error: bool) {
    let mut guard = REPLIES.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(call_id, crate::mcp::text_result(text, is_error));
    REPLIED.notify_all();
}

#[tauri::command]
pub fn plugins_set_enabled(app: tauri::AppHandle, ids: Vec<String>) {
    let ids: HashSet<String> = ids.into_iter().collect();
    if !ids.contains("editor") {
        editor::cancel_all(&app);
    }
    *ENABLED.lock().unwrap() = Some(ids);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_parses() {
        assert_eq!(manifests().len(), MANIFESTS.len());
        assert!(manifests().iter().all(|m| !m.id.is_empty()));
    }

    #[test]
    fn mermaid_offers_show_diagram() {
        assert_eq!(tool_owner("show_diagram").as_deref(), Some("mermaid"));
    }

    #[test]
    fn default_context_mentions_the_editor() {
        assert!(agent_context().iter().any(|c| c.contains("open_editor")));
    }

    #[test]
    fn editor_offers_open_editor() {
        let editor = manifests().iter().find(|m| m.id == "editor").unwrap();
        assert!(editor
            .tools
            .iter()
            .any(|t| tool_name(t) == Some("open_editor")));
    }
}
