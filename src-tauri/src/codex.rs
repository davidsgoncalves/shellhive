//! Codex sessions for the chat view, driven through `codex app-server`
//! (JSON-RPC, one JSON message per line on stdio). One app-server process per
//! tab. What it reports becomes the same chat entries the Claude chat reads
//! from its transcript, and the same hook events Claude's hooks send, so tab
//! state, the permission queue and notifications work unchanged.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::chat::{agent_hook, emit_entries, emit_usage, ChatEntry, StartInfo};
use crate::hooks::{now_ms, raise_permission, PORT, TOKEN_HEADER};
use crate::permissions::Decision;
use crate::sessions::truncate;

/// How long a request to the app-server may take before it counts as failed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A Codex approval waits in the queue this long; the chat has no terminal to
/// fall back to, so it is long.
const APPROVAL_WAIT: Duration = Duration::from_secs(3600);
const STEP_TEXT: usize = 400;

#[derive(Default)]
pub struct CodexSessions(Mutex<HashMap<String, Arc<Session>>>);

struct Session {
    tab_id: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    thread_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    /// Steps started and not finished, closed by hand when a turn is cut short.
    open_steps: Mutex<HashSet<String>>,
    /// Agent text so far, by item, while it streams in.
    streaming: Mutex<HashMap<String, String>>,
    /// Files each edit touches, kept for its approval request.
    file_changes: Mutex<HashMap<String, Value>>,
}

impl Session {
    fn write(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{msg}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(&json!({ "id": id, "method": method, "params": params }))?;
        rx.recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| format!("o Codex não respondeu a {method}"))?
    }

    fn thread(&self) -> Result<String, String> {
        self.thread_id.lock().unwrap().clone().ok_or_else(|| "sessão do Codex sem thread".into())
    }
}

fn entry(kind: &'static str, id: &str, text: String) -> ChatEntry {
    ChatEntry { kind, id: id.to_string(), text, tool: None, error: false }
}

fn hook(app: &AppHandle, tab_id: &str, name: &str, extra: Value) {
    agent_hook(app, tab_id, "codex", name, extra);
}

/// Text of a user message item: its text inputs joined.
fn user_text(item: &Value) -> String {
    item.get("content")
        .and_then(|c| c.as_array())
        .map(|parts| {
            parts
                .iter()
                .map(|p| match p.get("type").and_then(|t| t.as_str()) {
                    Some("text") => p.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    Some("localImage") | Some("image") => "[imagem]".to_string(),
                    _ => String::new(),
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// A started tool item as a chat step, with the tool name Claude would use.
fn step_of(item: &Value) -> Option<(ChatEntry, &'static str, Value)> {
    let id = str_of(item, "id");
    let (tool, label, text, input) = match str_of(item, "type") {
        "commandExecution" => {
            let cmd = item
                .get("commandActions")
                .and_then(|a| a.get(0))
                .and_then(|a| a.get("command"))
                .and_then(|c| c.as_str())
                .unwrap_or_else(|| str_of(item, "command"));
            ("Bash", "Comando", cmd.to_string(), json!({ "command": cmd }))
        }
        "fileChange" => {
            let paths = changed_paths(item);
            ("Edit", "Edição", paths.join(", "), json!({ "file_path": paths.first().cloned().unwrap_or_default() }))
        }
        "mcpToolCall" => {
            let name = format!("{}.{}", str_of(item, "server"), str_of(item, "tool"));
            let args = item.get("arguments").cloned().unwrap_or_default();
            ("mcp", "MCP", format!("{name} {}", if args.is_null() { String::new() } else { args.to_string() }), args)
        }
        "webSearch" => ("WebSearch", "Busca", str_of(item, "query").to_string(), json!({ "query": str_of(item, "query") })),
        _ => return None,
    };
    let step = ChatEntry { tool: Some(label.to_string()), ..entry("step", id, truncate(&text, STEP_TEXT)) };
    Some((step, tool, input))
}

fn changed_paths(item: &Value) -> Vec<String> {
    item.get("changes")
        .and_then(|c| c.as_array())
        .map(|list| list.iter().map(|c| str_of(c, "path").to_string()).collect())
        .unwrap_or_default()
}

/// A finished tool item as the result under its step.
fn result_of(item: &Value) -> Option<ChatEntry> {
    let id = str_of(item, "id");
    let status = str_of(item, "status");
    let failed = matches!(status, "failed" | "declined");
    let text = match str_of(item, "type") {
        "commandExecution" => {
            let code = item.get("exitCode").and_then(|c| c.as_i64());
            let out = str_of(item, "aggregatedOutput");
            return Some(ChatEntry {
                error: failed || code.is_some_and(|c| c != 0),
                ..entry("result", id, truncate(out, STEP_TEXT))
            });
        }
        "fileChange" => if failed { "não aplicada" } else { "aplicada" }.to_string(),
        "mcpToolCall" => {
            let content = item
                .get("result")
                .and_then(|r| r.get("content"))
                .and_then(|c| c.as_array())
                .map(|parts| parts.iter().map(|p| str_of(p, "text")).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let error = item.get("error").map(|e| e.to_string()).filter(|e| e != "null");
            error.unwrap_or(content)
        }
        "webSearch" => "ok".to_string(),
        _ => return None,
    };
    Some(ChatEntry { error: failed, ..entry("result", id, truncate(&text, STEP_TEXT)) })
}

/// The message inside an app-server error, which may itself be JSON in a string.
fn error_message(err: &Value) -> String {
    let raw = str_of(err, "message");
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| raw.to_string())
}

fn on_notification(app: &AppHandle, s: &Session, method: &str, params: &Value) {
    let tab = s.tab_id.as_str();
    match method {
        "turn/started" => {
            *s.turn_id.lock().unwrap() = params.pointer("/turn/id").and_then(|t| t.as_str()).map(str::to_string);
        }
        "item/started" => {
            let Some(item) = params.get("item") else { return };
            if str_of(item, "type") == "fileChange" {
                s.file_changes.lock().unwrap().insert(str_of(item, "id").to_string(), item.clone());
            }
            if let Some((step, tool, input)) = step_of(item) {
                s.open_steps.lock().unwrap().insert(step.id.clone());
                emit_entries(app, tab, vec![step]);
                hook(app, tab, "PreToolUse", json!({ "tool_name": tool, "tool_input": input }));
            }
        }
        "item/agentMessage/delta" => {
            let id = str_of(params, "itemId").to_string();
            let mut streaming = s.streaming.lock().unwrap();
            let text = streaming.entry(id.clone()).or_default();
            text.push_str(str_of(params, "delta"));
            emit_entries(app, tab, vec![entry("text", &id, text.clone())]);
        }
        "item/completed" => {
            let Some(item) = params.get("item") else { return };
            let id = str_of(item, "id");
            match str_of(item, "type") {
                "userMessage" => {
                    let text = user_text(item);
                    if !text.is_empty() {
                        emit_entries(app, tab, vec![entry("user", id, text)]);
                    }
                }
                "agentMessage" => {
                    s.streaming.lock().unwrap().remove(id);
                    let text = str_of(item, "text");
                    if !text.trim().is_empty() {
                        emit_entries(app, tab, vec![entry("text", id, text.to_string())]);
                    }
                }
                _ => {
                    if let Some(result) = result_of(item) {
                        s.open_steps.lock().unwrap().remove(id);
                        s.file_changes.lock().unwrap().remove(id);
                        emit_entries(app, tab, vec![result]);
                        hook(app, tab, "PostToolUse", json!({}));
                    }
                }
            }
        }
        "turn/completed" => {
            *s.turn_id.lock().unwrap() = None;
            let turn = params.get("turn").cloned().unwrap_or_default();
            let status = str_of(&turn, "status");
            // An interrupted turn leaves its running steps without an end.
            let open: Vec<String> = s.open_steps.lock().unwrap().drain().collect();
            let mut entries: Vec<ChatEntry> = open
                .iter()
                .map(|id| ChatEntry { error: true, ..entry("result", id, "interrompido".into()) })
                .collect();
            if status == "failed" {
                if let Some(err) = turn.get("error").filter(|e| !e.is_null()) {
                    let id = format!("{}:error", str_of(&turn, "id"));
                    entries.push(entry("error", &id, error_message(err)));
                }
            }
            emit_entries(app, tab, entries);
            hook(app, tab, "Stop", json!({}));
        }
        "account/rateLimits/updated" => {
            emit_usage(app, tab, "codex", params.get("rateLimits").cloned().unwrap_or_default());
        }
        _ => {}
    }
}

/// An approval the app-server asks of the client, answered from the queue.
fn on_server_request(app: &AppHandle, s: &Session, id: Value, method: &str, params: &Value) {
    let tab = s.tab_id.clone();
    let (payload, kind) = match method {
        "item/commandExecution/requestApproval" => {
            let cmd = params
                .get("commandActions")
                .and_then(|a| a.get(0))
                .and_then(|a| a.get("command"))
                .and_then(|c| c.as_str())
                .unwrap_or_else(|| str_of(params, "command"));
            let input = json!({ "command": cmd, "description": str_of(params, "reason") });
            (json!({ "tool_name": "Bash", "tool_input": input }), "decision")
        }
        "item/fileChange/requestApproval" => {
            let item = s.file_changes.lock().unwrap().get(str_of(params, "itemId")).cloned().unwrap_or_default();
            let paths = changed_paths(&item);
            let diff = item
                .get("changes")
                .and_then(|c| c.as_array())
                .map(|list| list.iter().map(|c| str_of(c, "diff")).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            let input = json!({ "file_path": paths.join(", "), "content": diff });
            (json!({ "tool_name": "Edit", "tool_input": input }), "decision")
        }
        "mcpServer/elicitation/request"
            if params.pointer("/_meta/codex_approval_kind").and_then(|k| k.as_str()) == Some("mcp_tool_call") =>
        {
            let tool = format!("mcp__{}", str_of(params, "serverName"));
            let input = json!({
                "description": str_of(params, "message"),
                "params": params.pointer("/_meta/tool_params").cloned().unwrap_or_default(),
            });
            (json!({ "tool_name": tool, "tool_input": input }), "action")
        }
        _ => {
            let _ = s.write(&json!({ "id": id, "error": { "code": -32601, "message": "não suportado pelo Shellhive" } }));
            return;
        }
    };
    let tool = payload["tool_name"].clone();
    hook(app, &tab, "PermissionRequest", json!({ "tool_name": tool }));
    let answer = raise_permission(app, Some(tab.clone()), payload, now_ms(), APPROVAL_WAIT);
    let allowed = matches!(answer, Some((Decision::Allow, _)));
    let result = if kind == "action" {
        json!({ "action": if allowed { "accept" } else { "decline" }, "content": null })
    } else {
        json!({ "decision": if allowed { "accept" } else { "decline" } })
    };
    let _ = s.write(&json!({ "id": id, "result": result }));
    hook(app, &tab, "PreToolUse", json!({ "tool_name": tool }));
}

fn read_loop(app: AppHandle, s: Arc<Session>, stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let method = msg.get("method").and_then(|m| m.as_str());
        match (method, msg.get("id")) {
            // A request from the server; its ids are its own, so `method` tells it apart.
            (Some(method), Some(id)) => {
                let (app, s, id, method, params) =
                    (app.clone(), s.clone(), id.clone(), method.to_string(), msg.get("params").cloned().unwrap_or_default());
                // Approvals block until someone decides; the reader keeps going.
                std::thread::spawn(move || on_server_request(&app, &s, id, &method, &params));
            }
            (Some(method), None) => {
                on_notification(&app, &s, method, msg.get("params").unwrap_or(&Value::Null));
            }
            (None, Some(id)) => {
                let Some(id) = id.as_u64() else { continue };
                if let Some(tx) = s.pending.lock().unwrap().remove(&id) {
                    let result = match msg.get("error") {
                        Some(err) => Err(error_message(err)),
                        None => Ok(msg.get("result").cloned().unwrap_or_default()),
                    };
                    let _ = tx.send(result);
                }
            }
            _ => {}
        }
    }
    // The process ended: the tab's Codex session is over.
    if let Some(sessions) = app.try_state::<CodexSessions>() {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&s.tab_id).is_some_and(|cur| Arc::ptr_eq(cur, &s)) {
            map.remove(&s.tab_id);
        }
    }
    hook(&app, &s.tab_id, "SessionEnd", json!({}));
}

fn session(state: &CodexSessions, tab_id: &str) -> Result<Arc<Session>, String> {
    state.0.lock().unwrap().get(tab_id).cloned().ok_or_else(|| "o Codex não está rodando nesta aba".into())
}

/// History of a resumed thread as chat entries. Only messages come back; the
/// app-server leaves the tool calls out of it.
fn history_entries(thread: &Value) -> Vec<ChatEntry> {
    let mut out = Vec::new();
    for (t, turn) in thread.get("turns").and_then(|t| t.as_array()).into_iter().flatten().enumerate() {
        for (i, item) in turn.get("items").and_then(|t| t.as_array()).into_iter().flatten().enumerate() {
            let id = format!("h{t}:{i}");
            match str_of(item, "type") {
                "userMessage" => {
                    let text = user_text(item);
                    if !text.is_empty() {
                        out.push(entry("user", &id, text));
                    }
                }
                "agentMessage" => out.push(entry("text", &id, str_of(item, "text").to_string())),
                _ => {}
            }
        }
    }
    out
}

/// Starts the tab's Codex: a new thread, or the thread `session_id` resumed. Uses `model`
/// when given and accepted, else the app-server's default model.
#[tauri::command]
pub async fn codex_start(
    app: AppHandle,
    tab_id: String,
    cwd: String,
    session_id: Option<String>,
    model: Option<String>,
) -> Result<StartInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start(&app, tab_id, cwd, session_id, model))
        .await
        .map_err(|e| e.to_string())?
}

fn start(app: &AppHandle, tab_id: String, cwd: String, thread_id: Option<String>, model: Option<String>) -> Result<StartInfo, String> {
    let state = app.state::<CodexSessions>();
    if let Some(old) = state.0.lock().unwrap().remove(&tab_id) {
        let _ = old.child.lock().unwrap().kill();
    }
    // With the user's shell PATH: an app opened from the Dock misses Homebrew.
    let mut child = crate::connections::tool("codex")
        .arg("app-server")
        .current_dir(&cwd)
        // Its hooks must not reach a tab: the app reports this session itself.
        .env_remove("SHELLHIVE_TAB_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("não foi possível abrir o Codex: {e}"))?;
    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let s = Arc::new(Session {
        tab_id: tab_id.clone(),
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        next_id: AtomicU64::new(1),
        pending: Mutex::default(),
        thread_id: Mutex::default(),
        turn_id: Mutex::default(),
        open_steps: Mutex::default(),
        streaming: Mutex::default(),
        file_changes: Mutex::default(),
    });
    state.0.lock().unwrap().insert(tab_id.clone(), s.clone());
    {
        let (app, s) = (app.clone(), s.clone());
        std::thread::spawn(move || read_loop(app, s, stdout));
    }

    let fail = |e: String| {
        let _ = s.child.lock().unwrap().kill();
        e
    };
    s.request(
        "initialize",
        // The fields used here were tested with the experimental API on.
        json!({
            "clientInfo": { "name": "shellhive", "title": "Shellhive", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true },
        }),
    )
    .map_err(fail)?;
    s.write(&json!({ "method": "initialized" })).map_err(fail)?;

    // The user's config may name a model this CLI does not know; pick one it lists.
    let list = s.request("model/list", json!({})).map_err(fail)?;
    let models: Vec<Value> = list
        .get("data")
        .and_then(|d| d.as_array())
        .map(|all| all.iter().filter(|m| m.get("hidden").and_then(|h| h.as_bool()) != Some(true)).cloned().collect())
        .unwrap_or_default();
    let names: Vec<String> = models.iter().map(|m| str_of(m, "id").to_string()).filter(|n| !n.is_empty()).collect();
    let default = models
        .iter()
        .find(|m| m.get("isDefault").and_then(|d| d.as_bool()) == Some(true))
        .map(|m| str_of(m, "id").to_string())
        .or_else(|| names.first().cloned())
        .ok_or_else(|| fail("o Codex não listou nenhum modelo".into()))?;
    let model = model.filter(|m| names.contains(m)).unwrap_or(default);

    let token = crate::hooks::token();
    let params = json!({
        "model": model,
        "cwd": cwd,
        // Without this the user's config may send approvals to a reviewer
        // subagent, and the app would never see them.
        "approvalsReviewer": "user",
        "config": { "mcp_servers": { "shellhive": {
            "url": format!("http://127.0.0.1:{PORT}/mcp"),
            "http_headers": { "X-Tab-Id": tab_id, TOKEN_HEADER: token },
        } } },
    });
    let reply = match &thread_id {
        Some(id) => {
            let mut p = params.clone();
            p["threadId"] = json!(id);
            match s.request("thread/resume", p) {
                // Codex saves a thread with its first message; one that never
                // got any has nothing to resume, so the tab starts a new one.
                Err(e) if e.contains("no rollout found") => s.request("thread/start", params),
                other => other,
            }
        }
        None => s.request("thread/start", params),
    }
    .map_err(fail)?;
    let thread = reply.get("thread").cloned().unwrap_or_default();
    let id = str_of(&thread, "id").to_string();
    if id.is_empty() {
        return Err(fail("o Codex não devolveu a thread".into()));
    }
    *s.thread_id.lock().unwrap() = Some(id.clone());
    // The limits come after each reply; reading them now fills the usage rings sooner.
    if let Ok(read) = s.request("account/rateLimits/read", json!({})) {
        if let Some(limits) = read.get("rateLimits").filter(|l| !l.is_null()) {
            emit_usage(app, &tab_id, "codex", limits.clone());
        }
    }
    emit_entries(app, &tab_id, history_entries(&thread));
    hook(app, &tab_id, "SessionStart", json!({ "session_id": id }));
    Ok(StartInfo { session_id: id, model, models: names })
}

/// Sends a message: a new turn, or into the running turn when there is one.
#[tauri::command]
pub async fn codex_send(
    app: AppHandle,
    tab_id: String,
    text: String,
    model: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = session(&app.state::<CodexSessions>(), &tab_id)?;
        let thread = s.thread()?;
        let mut input = vec![json!({ "type": "text", "text": text })];
        input.extend(images.unwrap_or_default().into_iter().map(|path| json!({ "type": "localImage", "path": path })));
        let input = Value::Array(input);
        hook(&app, &tab_id, "UserPromptSubmit", json!({ "prompt": text }));
        let running = s.turn_id.lock().unwrap().clone();
        match running {
            Some(turn) => s.request("turn/steer", json!({ "threadId": thread, "expectedTurnId": turn, "input": input })),
            None => {
                let mut params = json!({ "threadId": thread, "input": input });
                if let Some(m) = model {
                    params["model"] = json!(m);
                }
                s.request("turn/start", params)
            }
        }
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn codex_interrupt(app: AppHandle, tab_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = session(&app.state::<CodexSessions>(), &tab_id)?;
        let Some(turn) = s.turn_id.lock().unwrap().clone() else { return Ok(()) };
        s.request("turn/interrupt", json!({ "threadId": s.thread()?, "turnId": turn })).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ends the tab's Codex process. The thread stays saved and can be resumed.
#[tauri::command]
pub fn codex_stop(state: tauri::State<CodexSessions>, tab_id: String) {
    if let Some(s) = state.0.lock().unwrap().remove(&tab_id) {
        let _ = s.child.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_becomes_a_step_and_its_failure_an_error_result() {
        let started = json!({"type":"commandExecution","id":"e1","command":"/bin/zsh -lc 'ls x'","commandActions":[{"type":"listFiles","command":"ls x"}],"status":"inProgress"});
        let (step, tool, input) = step_of(&started).unwrap();
        assert_eq!((step.kind, step.id.as_str(), step.text.as_str(), tool), ("step", "e1", "ls x", "Bash"));
        assert_eq!(input["command"], "ls x");
        let done = json!({"type":"commandExecution","id":"e1","status":"failed","aggregatedOutput":"ls: x: No such file","exitCode":1});
        let r = result_of(&done).unwrap();
        assert!(r.error && r.kind == "result" && r.text.contains("No such file"));
    }

    #[test]
    fn an_error_inside_a_json_string_is_unwrapped() {
        let err = json!({"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"model requires a newer version\"}}"});
        assert_eq!(error_message(&err), "model requires a newer version");
        assert_eq!(error_message(&json!({"message":"plain"})), "plain");
    }

    #[test]
    fn resumed_history_keeps_messages_in_order() {
        let thread = json!({"turns":[{"items":[
            {"type":"userMessage","id":"item-1","content":[{"type":"text","text":"oi"}]},
            {"type":"agentMessage","id":"item-2","text":"olá"}
        ]}]});
        let h = history_entries(&thread);
        assert_eq!(h.iter().map(|e| (e.kind, e.text.as_str())).collect::<Vec<_>>(), vec![("user", "oi"), ("text", "olá")]);
    }
}
