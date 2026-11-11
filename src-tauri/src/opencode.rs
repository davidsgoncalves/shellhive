//! OpenCode sessions for the chat view. Each tab gets its own `opencode serve`
//! on a free local port, protected by a password made for it. Messages go
//! through the server's HTTP API (v1; v2 fails in 1.17) and the conversation
//! comes back on its event stream, turned into the chat entries and hook
//! events the rest of the app already reads.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::chat::{agent_hook, emit_entries, emit_usage, ChatEntry, StartInfo};
use crate::hooks::{now_ms, raise_permission_as, PORT, TOKEN_HEADER};
use crate::permissions::{Decision, Permissions};
use crate::sessions::{tool_detail, truncate};

const PROVIDER: &str = "opencode";
/// How long the server may take to come up.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// An approval waits in the queue this long; the chat has no terminal to fall
/// back to, so it is long.
const APPROVAL_WAIT: Duration = Duration::from_secs(3600);
const STEP_TEXT: usize = 400;

#[derive(Default)]
pub struct OpencodeSessions(Mutex<HashMap<String, Arc<Server>>>);

struct Server {
    tab_id: String,
    base: String,
    auth: String,
    child: Mutex<Child>,
    session_id: Mutex<Option<String>>,
    http: ureq::Agent,
    /// The password, in a file only the user can read, for `opencode attach`.
    password_file: Option<std::path::PathBuf>,
    /// Permission requests answered in OpenCode's own interface.
    answered_elsewhere: Mutex<HashSet<String>>,
}

impl Server {
    fn get(&self, path: &str) -> Result<Value, String> {
        let mut resp = self
            .http
            .get(format!("{}{path}", self.base))
            .header("Authorization", &self.auth)
            .call()
            .map_err(|e| format!("OpenCode GET {path}: {e}"))?;
        let body = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
        Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let mut resp = self
            .http
            .post(format!("{}{path}", self.base))
            .header("Authorization", &self.auth)
            .content_type("application/json")
            .send(body.to_string())
            .map_err(|e| format!("OpenCode POST {path}: {e}"))?;
        let body = resp.body_mut().read_to_string().unwrap_or_default();
        Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    fn session(&self) -> Result<String, String> {
        self.session_id.lock().unwrap().clone().ok_or_else(|| "OpenCode sem sessão".into())
    }

    /// Asks the server to quit, then kills it if it lingers. TERM lets it
    /// close the language servers and MCP processes it started.
    fn shut_down(&self) {
        if let Some(f) = &self.password_file {
            let _ = std::fs::remove_file(f);
        }
        let mut child = self.child.lock().unwrap();
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
            let until = Instant::now() + Duration::from_secs(2);
            while Instant::now() < until {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn entry(kind: &'static str, id: &str, text: String) -> ChatEntry {
    ChatEntry { kind, id: id.to_string(), text, tool: None, error: false }
}

/// A tool as the chat labels it, the name Claude would give it for hooks and
/// rules, and the input in Claude's shape.
fn tool_of(tool: &str, input: &Value) -> (String, String, Value) {
    let path = || str_of(input, "filePath").to_string();
    match tool {
        "bash" => ("Comando".into(), "Bash".into(), json!({ "command": str_of(input, "command") })),
        "edit" | "write" | "patch" | "multiedit" => ("Edição".into(), "Edit".into(), json!({ "file_path": path() })),
        "read" => ("Leitura".into(), "Read".into(), json!({ "file_path": path() })),
        "webfetch" => ("Web".into(), "WebFetch".into(), json!({ "url": str_of(input, "url") })),
        other => (other.to_string(), other.to_string(), input.clone()),
    }
}

/// The text a step shows: the command or file when there is one.
fn step_text(input: &Value) -> String {
    for key in ["command", "filePath", "pattern", "url", "description"] {
        let v = str_of(input, key);
        if !v.is_empty() {
            return truncate(v, STEP_TEXT);
        }
    }
    tool_detail(input, STEP_TEXT)
}

fn step_entry(part: &Value, input: &Value) -> ChatEntry {
    let (label, _, _) = tool_of(str_of(part, "tool"), input);
    ChatEntry { tool: Some(label), ..entry("step", str_of(part, "id"), step_text(input)) }
}

fn result_entry(part: &Value, state: &Value) -> ChatEntry {
    let failed = str_of(state, "status") == "error";
    let text = if failed { str_of(state, "error") } else { str_of(state, "output") };
    let exit = state.pointer("/metadata/exit").and_then(|e| e.as_i64());
    ChatEntry {
        error: failed || exit.is_some_and(|c| c != 0),
        ..entry("result", str_of(part, "id"), truncate(text, STEP_TEXT))
    }
}

/// What one server event means for the tab.
#[derive(Debug, PartialEq)]
enum Out {
    Entries(Vec<ChatEntry>),
    Hook(&'static str, Value),
    /// A permission request, answered from the queue.
    Permission(Value),
    /// A permission answered, maybe in OpenCode's own interface.
    Replied(String),
    /// A question the chat cannot show yet; it is turned down.
    Question(String),
    /// The turn ended.
    Idle,
}

/// Follows one session through the server's event stream, which carries every
/// session of the server.
#[derive(Default)]
struct Tracker {
    session_id: String,
    /// Role of each message seen, since parts only name their message.
    roles: HashMap<String, String>,
    /// Steps shown and not finished, closed by hand when a turn is cut short.
    open_steps: HashSet<String>,
    /// Steps already shown, finished or not.
    shown_steps: HashSet<String>,
    /// Agent text so far, by part, while it streams in.
    streaming: HashMap<String, String>,
    /// The server says busy and idle more than once per turn.
    busy: bool,
}

impl Tracker {
    fn on_event(&mut self, ev: &Value) -> Vec<Out> {
        let props = ev.get("properties").cloned().unwrap_or_default();
        let session = props
            .get("sessionID")
            .or_else(|| props.pointer("/info/sessionID"))
            .or_else(|| props.pointer("/part/sessionID"))
            .and_then(|s| s.as_str())
            .unwrap_or("");
        if session != self.session_id {
            return Vec::new();
        }
        match str_of(ev, "type") {
            "message.updated" => {
                let info = props.get("info").cloned().unwrap_or_default();
                self.roles.insert(str_of(&info, "id").to_string(), str_of(&info, "role").to_string());
                Vec::new()
            }
            "message.part.delta" if str_of(&props, "field") == "text" => {
                let id = str_of(&props, "partID").to_string();
                let text = self.streaming.entry(id.clone()).or_default();
                text.push_str(str_of(&props, "delta"));
                vec![Out::Entries(vec![entry("text", &id, text.clone())])]
            }
            "message.part.updated" => self.on_part(props.get("part").unwrap_or(&Value::Null)),
            "session.status" => {
                if props.pointer("/status/type").and_then(|t| t.as_str()) == Some("busy") {
                    self.busy = true;
                }
                Vec::new()
            }
            "session.idle" => self.on_idle(),
            "session.error" => {
                let err = props.get("error").cloned().unwrap_or_default();
                if str_of(&err, "name") == "MessageAbortedError" {
                    return Vec::new();
                }
                let msg = err
                    .pointer("/data/message")
                    .and_then(|m| m.as_str())
                    .unwrap_or_else(|| str_of(&err, "name"))
                    .to_string();
                vec![Out::Entries(vec![entry("error", str_of(ev, "id"), msg)])]
            }
            "permission.asked" => vec![Out::Permission(props)],
            "permission.replied" => vec![Out::Replied(str_of(&props, "requestID").to_string())],
            "question.asked" => vec![Out::Question(str_of(&props, "id").to_string())],
            _ => Vec::new(),
        }
    }

    fn on_part(&mut self, part: &Value) -> Vec<Out> {
        let id = str_of(part, "id").to_string();
        let role = self.roles.get(str_of(part, "messageID")).map(String::as_str).unwrap_or("assistant");
        match str_of(part, "type") {
            "text" => {
                let text = str_of(part, "text");
                let synthetic = part.get("synthetic").and_then(|s| s.as_bool()).unwrap_or(false);
                if text.trim().is_empty() || synthetic {
                    return Vec::new();
                }
                if role == "user" {
                    return vec![Out::Entries(vec![entry("user", &id, text.to_string())])];
                }
                self.streaming.remove(&id);
                vec![Out::Entries(vec![entry("text", &id, text.to_string())])]
            }
            "file" if role == "user" => vec![Out::Entries(vec![entry("user", &id, "[imagem]".into())])],
            "tool" => {
                let state = part.get("state").cloned().unwrap_or_default();
                let input = state.get("input").cloned().unwrap_or_default();
                let mut out = Vec::new();
                let mut entries = Vec::new();
                let status = str_of(&state, "status");
                // A pending tool has no input yet; it shows once it runs.
                if status != "pending" && self.shown_steps.insert(id.clone()) {
                    entries.push(step_entry(part, &input));
                    self.open_steps.insert(id.clone());
                    let (_, tool, claude_input) = tool_of(str_of(part, "tool"), &input);
                    out.push(Out::Hook("PreToolUse", json!({ "tool_name": tool, "tool_input": claude_input })));
                }
                if matches!(status, "completed" | "error") && self.open_steps.remove(&id) {
                    entries.push(result_entry(part, &state));
                    out.push(Out::Hook("PostToolUse", json!({})));
                }
                if !entries.is_empty() {
                    out.insert(0, Out::Entries(entries));
                }
                out
            }
            _ => Vec::new(),
        }
    }

    fn on_idle(&mut self) -> Vec<Out> {
        if !self.busy {
            return Vec::new();
        }
        self.busy = false;
        self.streaming.clear();
        let open: Vec<ChatEntry> = self
            .open_steps
            .drain()
            .map(|id| ChatEntry { error: true, ..entry("result", &id, "interrompido".into()) })
            .collect();
        let mut out = Vec::new();
        if !open.is_empty() {
            out.push(Out::Entries(open));
        }
        out.push(Out::Hook("Stop", json!({})));
        out.push(Out::Idle);
        out
    }
}

/// The saved conversation of a session as chat entries, tools included.
fn history_entries(messages: &Value) -> Vec<ChatEntry> {
    let mut t = Tracker::default();
    let mut out = Vec::new();
    for m in messages.as_array().into_iter().flatten() {
        let info = m.get("info").cloned().unwrap_or_default();
        t.roles.insert(str_of(&info, "id").to_string(), str_of(&info, "role").to_string());
        for part in m.get("parts").and_then(|p| p.as_array()).into_iter().flatten() {
            for o in t.on_part(part) {
                if let Out::Entries(e) = o {
                    out.extend(e);
                }
            }
        }
    }
    out
}

/// What the queue shows for a permission request, in Claude's shape.
fn permission_payload(props: &Value) -> Value {
    let meta = props.get("metadata").cloned().unwrap_or_default();
    let first = props.pointer("/patterns/0").and_then(|p| p.as_str()).unwrap_or("").to_string();
    let patterns = props
        .get("patterns")
        .and_then(|p| p.as_array())
        .map(|list| list.iter().filter_map(|p| p.as_str()).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let (tool, input) = match str_of(props, "permission") {
        "bash" => {
            let cmd = meta.get("command").and_then(|c| c.as_str()).map(str::to_string).unwrap_or(patterns);
            ("Bash".to_string(), json!({ "command": cmd }))
        }
        "edit" => ("Edit".to_string(), json!({ "file_path": first, "content": str_of(&meta, "diff") })),
        "read" => ("Read".to_string(), json!({ "file_path": first })),
        "webfetch" => ("WebFetch".to_string(), json!({ "url": first })),
        other => (other.to_string(), json!({ "description": patterns, "params": meta })),
    };
    json!({ "tool_name": tool, "tool_input": input })
}

fn answer_permission(app: &AppHandle, server: &Server, props: &Value) {
    let tab = server.tab_id.clone();
    let payload = permission_payload(props);
    let tool = payload["tool_name"].clone();
    agent_hook(app, &tab, PROVIDER, "PermissionRequest", json!({ "tool_name": tool }));
    let id = str_of(props, "id");
    let answer = raise_permission_as(app, queue_id(id), Some(tab.clone()), payload, now_ms(), APPROVAL_WAIT);
    if server.answered_elsewhere.lock().unwrap().remove(id) {
        return;
    }
    let reply = if matches!(answer, Some((Decision::Allow, _))) { "once" } else { "reject" };
    if let Err(e) = server.post(&format!("/permission/{id}/reply"), &json!({ "reply": reply })) {
        crate::errors::record("opencode", &e);
    }
    agent_hook(app, &tab, PROVIDER, "PreToolUse", json!({ "tool_name": tool }));
}

/// The queue's id for an OpenCode permission request.
fn queue_id(request: &str) -> String {
    format!("opencode-{request}")
}

fn report_cost(app: &AppHandle, server: &Server) {
    let Ok(id) = server.session() else { return };
    if let Ok(s) = server.get(&format!("/session/{id}")) {
        emit_usage(app, &server.tab_id, PROVIDER, json!({ "cost": s.get("cost").cloned().unwrap_or_default() }));
    }
}

/// Reads the server's events, as the tracker sees them, until the stream ends.
fn follow(server: &Server, mut tracker: Tracker, mut each: impl FnMut(Out) -> bool) {
    // The stream stays open, so this request has no time limit.
    let stream: ureq::Agent = ureq::Agent::config_builder().build().into();
    let Ok(resp) = stream.get(format!("{}/event", server.base)).header("Authorization", &server.auth).call() else {
        return;
    };
    for line in BufReader::new(resp.into_body().into_reader()).lines() {
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data: ") else { continue };
        let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
        for out in tracker.on_event(&ev) {
            if !each(out) {
                return;
            }
        }
    }
}

fn read_events(app: AppHandle, server: Arc<Server>, tracker: Tracker) {
    follow(&server, tracker, |out| {
        match out {
            Out::Entries(e) => emit_entries(&app, &server.tab_id, e),
            Out::Hook(name, extra) => agent_hook(&app, &server.tab_id, PROVIDER, name, extra),
            Out::Permission(props) => {
                let (app, server) = (app.clone(), server.clone());
                // Waits for someone to decide; events keep coming meanwhile.
                std::thread::spawn(move || answer_permission(&app, &server, &props));
            }
            Out::Question(id) => {
                let _ = server.post(&format!("/question/{id}/reject"), &json!({}));
                let note = "O OpenCode fez uma pergunta com opções, que o chat ainda não mostra. Ela foi recusada.";
                emit_entries(&app, &server.tab_id, vec![entry("error", &format!("q:{id}"), note.into())]);
            }
            Out::Idle => report_cost(&app, &server),
            Out::Replied(id) => {
                // Answered in OpenCode's interface: the queue stops asking. When
                // the answer came from the queue, there is nothing left to withdraw.
                let perms = app.state::<Permissions>();
                server.answered_elsewhere.lock().unwrap().insert(id.clone());
                if !perms.decide(&queue_id(&id), Decision::Ask, "respondido no OpenCode".into()) {
                    server.answered_elsewhere.lock().unwrap().remove(&id);
                }
            }
        }
        true
    });
    // The stream ended: the server is gone or going.
    if let Some(sessions) = app.try_state::<OpencodeSessions>() {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&server.tab_id).is_some_and(|cur| Arc::ptr_eq(cur, &server)) {
            map.remove(&server.tab_id);
        }
    }
    agent_hook(&app, &server.tab_id, PROVIDER, "SessionEnd", json!({}));
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn password() -> String {
    let mut bytes = [0u8; 24];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Models of the providers the user has a key for, as `provider/model`, and
/// the one to use: the asked one when listed, else the user's configured one,
/// else a provider's default.
fn pick_model(server: &Server, wanted: Option<String>) -> Result<(String, Vec<String>), String> {
    let providers = server.get("/provider")?;
    let connected: Vec<&str> = providers
        .get("connected")
        .and_then(|c| c.as_array())
        .map(|c| c.iter().filter_map(|p| p.as_str()).collect())
        .unwrap_or_default();
    let mut models = Vec::new();
    for p in providers.get("all").and_then(|a| a.as_array()).into_iter().flatten() {
        let pid = str_of(p, "id");
        if !connected.contains(&pid) {
            continue;
        }
        for mid in p.get("models").and_then(|m| m.as_object()).into_iter().flat_map(|m| m.keys()) {
            models.push(format!("{pid}/{mid}"));
        }
    }
    let configured = server.get("/config").ok().map(|c| str_of(&c, "model").to_string()).filter(|m| !m.is_empty());
    let fallback = connected.iter().find_map(|pid| {
        providers.pointer(&format!("/default/{pid}")).and_then(|m| m.as_str()).map(|m| format!("{pid}/{m}"))
    });
    let model = wanted
        .filter(|m| models.contains(m))
        .or(configured)
        .or(fallback)
        .or_else(|| models.first().cloned())
        .ok_or("o OpenCode não tem nenhum provedor configurado")?;
    Ok((model, models))
}

fn prompt_body(text: &str, model: Option<&str>) -> Value {
    let mut body = json!({ "parts": [{ "type": "text", "text": text }] });
    if let Some((provider, id)) = model.and_then(|m| m.split_once('/')) {
        body["model"] = json!({ "providerID": provider, "modelID": id });
    }
    body
}

/// Starts the tab's OpenCode server, with the session `session_id` when it
/// still exists, else a new one.
#[tauri::command]
pub async fn opencode_start(
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

/// A running server for a tab with its session ready, and the session's
/// saved messages.
fn launch(
    tab_id: &str,
    cwd: &str,
    session_id: Option<String>,
    model: Option<String>,
) -> Result<(Arc<Server>, StartInfo, Value), String> {
    let port = free_port()?;
    let pass = password();
    let mcp = json!({ "mcp": { "shellhive": {
        "type": "remote",
        "url": format!("http://127.0.0.1:{PORT}/mcp"),
        "headers": { "X-Tab-Id": tab_id, TOKEN_HEADER: crate::hooks::token() },
        "oauth": false,
    } } });
    // With the user's shell PATH: an app opened from the Dock misses Homebrew.
    let child = crate::connections::tool("opencode")
        .args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(cwd)
        .env_remove("SHELLHIVE_TAB_ID")
        .env("OPENCODE_SERVER_PASSWORD", &pass)
        .env("OPENCODE_CONFIG_CONTENT", mcp.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("não foi possível abrir o OpenCode: {e}"))?;
    let http: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(REQUEST_TIMEOUT)).build().into();
    let password_file = crate::paths::data_dir().map(|d| d.join("opencode").join(format!("{tab_id}.pw")));
    if let Some(f) = &password_file {
        let _ = std::fs::create_dir_all(f.parent().unwrap_or(f));
        if let Err(e) = crate::hooks::write_private(f, &pass) {
            crate::errors::record("opencode", &format!("senha não gravada: {e}"));
        }
    }
    let server = Arc::new(Server {
        tab_id: tab_id.to_string(),
        base: format!("http://127.0.0.1:{port}"),
        auth: format!("Basic {}", B64.encode(format!("opencode:{pass}"))),
        child: Mutex::new(child),
        session_id: Mutex::default(),
        http,
        password_file,
        answered_elsewhere: Mutex::default(),
    });
    let fail = |e: String| {
        server.shut_down();
        e
    };

    let until = Instant::now() + READY_TIMEOUT;
    loop {
        if server.get("/global/health").is_ok() {
            break;
        }
        if let Ok(Some(status)) = server.child.lock().unwrap().try_wait() {
            return Err(format!("o OpenCode fechou ao abrir ({status})"));
        }
        if Instant::now() > until {
            return Err(fail("o OpenCode não respondeu a tempo".into()));
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let (model, models) = pick_model(&server, model).map_err(fail)?;
    let existing = session_id.filter(|id| server.get(&format!("/session/{id}")).is_ok());
    let id = match existing {
        Some(id) => id,
        None => {
            let s = server.post("/session", &json!({})).map_err(fail)?;
            str_of(&s, "id").to_string()
        }
    };
    if id.is_empty() {
        return Err(fail("o OpenCode não criou a sessão".into()));
    }
    *server.session_id.lock().unwrap() = Some(id.clone());
    let history = server.get(&format!("/session/{id}/message")).unwrap_or_default();
    Ok((server, StartInfo { session_id: id, model, models }, history))
}

fn start(app: &AppHandle, tab_id: String, cwd: String, session_id: Option<String>, model: Option<String>) -> Result<StartInfo, String> {
    let state = app.state::<OpencodeSessions>();
    if let Some(old) = state.0.lock().unwrap().remove(&tab_id) {
        old.shut_down();
    }
    let (server, info, history) = launch(&tab_id, &cwd, session_id, model)?;
    let id = info.session_id.clone();
    state.0.lock().unwrap().insert(tab_id.clone(), server.clone());
    let tracker = Tracker { session_id: id.clone(), ..Tracker::default() };
    {
        let (app, server) = (app.clone(), server.clone());
        std::thread::spawn(move || read_events(app, server, tracker));
    }
    emit_entries(app, &tab_id, history_entries(&history));
    agent_hook(app, &tab_id, PROVIDER, "SessionStart", json!({ "session_id": id }));
    report_cost(app, &server);
    Ok(info)
}

fn server(app: &AppHandle, tab_id: &str) -> Result<Arc<Server>, String> {
    let state = app.state::<OpencodeSessions>();
    let map = state.0.lock().unwrap();
    map.get(tab_id).cloned().ok_or_else(|| "o OpenCode não está rodando nesta aba".into())
}

/// Sends a message. The server queues it when a turn is running.
#[tauri::command]
pub async fn opencode_send(
    app: AppHandle,
    tab_id: String,
    text: String,
    model: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = server(&app, &tab_id)?;
        let id = s.session()?;
        let mut body = prompt_body(&text, model.as_deref());
        for path in images.unwrap_or_default() {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let mime = crate::chat::image_mime(&path);
            let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if let Some(parts) = body["parts"].as_array_mut() {
                parts.push(json!({ "type": "file", "mime": mime, "filename": name, "url": format!("data:{mime};base64,{}", B64.encode(bytes)) }));
            }
        }
        agent_hook(&app, &tab_id, PROVIDER, "UserPromptSubmit", json!({ "prompt": text }));
        s.post(&format!("/session/{id}/prompt_async"), &body).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn opencode_interrupt(app: AppHandle, tab_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = server(&app, &tab_id)?;
        let id = s.session()?;
        s.post(&format!("/session/{id}/abort"), &json!({})).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ends the tab's server. The session stays saved and can be resumed.
#[tauri::command]
pub async fn opencode_stop(app: AppHandle, tab_id: String) {
    let gone = app.state::<OpencodeSessions>().0.lock().unwrap().remove(&tab_id);
    if let Some(s) = gone {
        let _ = tauri::async_runtime::spawn_blocking(move || s.shut_down()).await;
    }
}

/// The line that opens OpenCode's own interface on the tab's server and
/// session. The password is read from its file, so it stays out of the
/// command line and the shell history.
#[tauri::command]
pub fn opencode_attach_line(app: AppHandle, tab_id: String) -> Result<String, String> {
    let s = server(&app, &tab_id)?;
    let id = s.session()?;
    let file = s.password_file.as_ref().ok_or("sem arquivo de senha")?.to_string_lossy().into_owned();
    let q = |v: &str| format!("'{}'", v.replace('\'', "'\\''"));
    if cfg!(windows) {
        return Ok(format!(
            "$env:OPENCODE_SERVER_PASSWORD = Get-Content {}; opencode attach {} --session {}\r",
            q(&file),
            q(&s.base),
            q(&id)
        ));
    }
    Ok(format!("OPENCODE_SERVER_PASSWORD=\"$(cat {})\" opencode attach {} --session {}\n", q(&file), q(&s.base), q(&id)))
}

/// Ends every server; they would outlive the app otherwise.
pub fn stop_all(app: &AppHandle) {
    let all: Vec<Arc<Server>> = app.state::<OpencodeSessions>().0.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all {
        s.shut_down();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "ses_1";

    fn ev(kind: &str, props: Value) -> Value {
        json!({ "id": "evt", "type": kind, "properties": props })
    }

    fn user_msg(id: &str) -> Value {
        ev("message.updated", json!({ "sessionID": SID, "info": { "id": id, "role": "user", "sessionID": SID } }))
    }

    fn part(p: Value) -> Value {
        ev("message.part.updated", json!({ "sessionID": SID, "part": p }))
    }

    fn entries(outs: Vec<Out>) -> Vec<ChatEntry> {
        outs.into_iter()
            .flat_map(|o| match o {
                Out::Entries(e) => e,
                _ => Vec::new(),
            })
            .collect()
    }

    #[test]
    fn a_turn_with_a_tool_becomes_message_step_result_and_one_stop() {
        let mut t = Tracker { session_id: SID.into(), ..Tracker::default() };
        let mut all = Vec::new();
        let tool = |state: Value| part(json!({ "id": "prt_t", "messageID": "msg_a", "type": "tool", "tool": "bash", "state": state }));
        let cmd = json!({ "command": "echo hi" });
        for e in [
            user_msg("msg_u"),
            part(json!({ "id": "prt_u", "messageID": "msg_u", "type": "text", "text": "roda" })),
            ev("session.status", json!({ "sessionID": SID, "status": { "type": "busy" } })),
            tool(json!({ "status": "pending", "input": {}, "raw": "" })),
            tool(json!({ "status": "running", "input": cmd })),
            tool(json!({ "status": "running", "input": cmd, "metadata": { "output": "hi" } })),
            tool(json!({ "status": "completed", "input": cmd, "output": "hi\n", "metadata": { "exit": 0 } })),
            ev("message.part.delta", json!({ "sessionID": SID, "partID": "prt_x", "field": "text", "delta": "pro" })),
            part(json!({ "id": "prt_x", "messageID": "msg_b", "type": "text", "text": "pronto" })),
            ev("session.idle", json!({ "sessionID": SID })),
            ev("session.idle", json!({ "sessionID": SID })),
            ev("session.idle", json!({ "sessionID": "ses_other" })),
        ] {
            all.extend(t.on_event(&e));
        }
        let stops = all.iter().filter(|o| matches!(o, Out::Hook("Stop", _))).count();
        let pre = all.iter().filter(|o| matches!(o, Out::Hook("PreToolUse", _))).count();
        assert_eq!((stops, pre), (1, 1));
        let got: Vec<(&str, String)> = entries(all).into_iter().map(|e| (e.kind, e.text)).collect();
        assert_eq!(
            got,
            vec![
                ("user", "roda".into()),
                ("step", "echo hi".into()),
                ("result", "hi".into()),
                ("text", "pro".into()),
                ("text", "pronto".into()),
            ]
        );
    }

    #[test]
    fn an_aborted_turn_closes_its_steps_without_an_error_message() {
        let mut t = Tracker { session_id: SID.into(), ..Tracker::default() };
        t.on_event(&ev("session.status", json!({ "sessionID": SID, "status": { "type": "busy" } })));
        t.on_event(&part(json!({ "id": "prt_t", "messageID": "m", "type": "tool", "tool": "bash", "state": { "status": "running", "input": { "command": "sleep 30" } } })));
        let aborted = t.on_event(&ev("session.error", json!({ "sessionID": SID, "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } } })));
        assert!(aborted.is_empty());
        let idle = entries(t.on_event(&ev("session.idle", json!({ "sessionID": SID }))));
        assert_eq!((idle[0].kind, idle[0].error), ("result", true));
        let failed = entries(t.on_event(&ev("session.error", json!({ "sessionID": SID, "error": { "name": "APIError", "data": { "message": "User not found." } } }))));
        assert_eq!((failed[0].kind, failed[0].text.as_str()), ("error", "User not found."));
    }

    #[test]
    fn a_bash_permission_reaches_the_queue_as_a_bash_call() {
        let props = json!({ "id": "per_1", "sessionID": SID, "permission": "bash", "patterns": ["echo hi"], "metadata": { "command": "echo hi" }, "always": ["echo *"] });
        let p = permission_payload(&props);
        assert_eq!((p["tool_name"].as_str(), p["tool_input"]["command"].as_str()), (Some("Bash"), Some("echo hi")));
    }

    #[test]
    fn saved_history_keeps_messages_and_tools_in_order() {
        let history = json!([
            { "info": { "id": "m1", "role": "user" }, "parts": [{ "id": "p1", "messageID": "m1", "type": "text", "text": "oi" }] },
            { "info": { "id": "m2", "role": "assistant" }, "parts": [
                { "id": "p2", "messageID": "m2", "type": "step-start" },
                { "id": "p3", "messageID": "m2", "type": "tool", "tool": "read", "state": { "status": "completed", "input": { "filePath": "/a.txt" }, "output": "x" } },
                { "id": "p4", "messageID": "m2", "type": "text", "text": "li" }
            ] }
        ]);
        let got: Vec<(&str, String)> = history_entries(&history).into_iter().map(|e| (e.kind, e.text)).collect();
        assert_eq!(
            got,
            vec![("user", "oi".into()), ("step", "/a.txt".into()), ("result", "x".into()), ("text", "li".into())]
        );
    }

    /// Runs a turn against a real `opencode serve`. Needs OPENCODE_TEST_DIR, a
    /// folder whose opencode.json points at a model that answers RUNTOOL with
    /// a bash call and asks before running bash.
    #[test]
    #[ignore]
    fn a_live_turn_with_an_approval() {
        let dir = std::env::var("OPENCODE_TEST_DIR").expect("OPENCODE_TEST_DIR");
        let (server, info, _) = launch("tab-test", &dir, None, None).unwrap();
        assert!(info.session_id.starts_with("ses_"), "{}", info.session_id);
        let reader = {
            let server = server.clone();
            let tracker = Tracker { session_id: info.session_id.clone(), ..Tracker::default() };
            std::thread::spawn(move || {
                let mut seen = Vec::new();
                follow(&server, tracker, |out| {
                    if let Out::Permission(props) = &out {
                        let id = str_of(props, "id");
                        server.post(&format!("/permission/{id}/reply"), &json!({ "reply": "once" })).unwrap();
                    }
                    let idle = out == Out::Idle;
                    seen.push(out);
                    !idle
                });
                seen
            })
        };
        std::thread::sleep(Duration::from_millis(500));
        let body = prompt_body("RUNTOOL please", Some(&info.model));
        server.post(&format!("/session/{}/prompt_async", info.session_id), &body).unwrap();
        let seen = reader.join().unwrap();
        let cost = server.get(&format!("/session/{}", info.session_id)).unwrap()["cost"].clone();
        let resumed = history_entries(&server.get(&format!("/session/{}/message", info.session_id)).unwrap());
        let _ = server.http.delete(format!("{}/session/{}", server.base, info.session_id)).header("Authorization", &server.auth).call();
        server.shut_down();
        let asked = seen.iter().filter(|o| matches!(o, Out::Permission(_))).count();
        let got: Vec<(&str, String)> = entries(seen).into_iter().map(|e| (e.kind, e.text)).collect();
        eprintln!("model {} cost {cost} entries {got:?}", info.model);
        assert_eq!(asked, 1);
        assert!(got.contains(&("user", "RUNTOOL please".into())));
        assert!(got.iter().any(|(k, t)| *k == "result" && t.contains("hi-from-tool")));
        let kinds: Vec<&str> = resumed.iter().map(|e| e.kind).collect();
        assert_eq!(kinds.first(), Some(&"user"));
        assert!(kinds.contains(&"step") && kinds.contains(&"result") && kinds.last() == Some(&"text"), "{kinds:?}");
    }
}
