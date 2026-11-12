use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Response, Server};

use crate::db::Db;
use crate::permissions::{Permissions, DECISION_TIMEOUT};

pub const PORT: u16 = if cfg!(feature = "preview") {
    47832
} else {
    47831
};

/// Header every caller of the local server sends with the current token.
pub const TOKEN_HEADER: &str = "X-Shellhive-Token";

static TOKEN: OnceLock<String> = OnceLock::new();

/// File holding the token, readable only by the user. Hook scripts read it on
/// each call, so they keep working after the app restarts with a new one.
pub fn token_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("token"))
}

/// The token for this run of the app, created on first use. Any web page can
/// reach 127.0.0.1, so the server answers only callers that can read the file.
pub fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        let mut bytes = [0u8; 32];
        if let Err(e) = getrandom::fill(&mut bytes) {
            crate::errors::record("hooks", &format!("token aleatorio falhou: {e}"));
        }
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        if let Some(path) = token_path() {
            if let Err(e) = write_private(&path, &token) {
                crate::errors::record("hooks", &format!("token nao gravado: {e}"));
            }
        }
        token
    })
}

/// Writes a file only its owner can read.
pub(crate) fn write_private(path: &PathBuf, content: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // A file left by an older version keeps its mode on open.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(content.as_bytes())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, content)
    }
}

/// Whether a request may reach the server: it carries the token, and it does
/// not come from a browser. A page sends Origin on cross-site requests, and a
/// DNS rebinding attack shows up as a Host other than the loopback address.
fn request_allowed(
    origin: Option<&str>,
    host: Option<&str>,
    token: Option<&str>,
    expected: &str,
) -> bool {
    if origin.is_some() {
        return false;
    }
    let host_ok =
        host.is_some_and(|h| h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"));
    host_ok && token.is_some_and(|t| same_secret(t.as_bytes(), expected.as_bytes()))
}

/// Compares without stopping at the first different byte.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// What SessionStart tells Claude about running inside this app.
/// What Claude is told when a session starts: that it runs inside Shellhive,
/// plus a sentence from each enabled plugin.
fn session_context() -> serde_json::Value {
    let mut text = String::from(
        "Voce esta rodando dentro do Shellhive, um terminal com abas agrupadas feito para o Claude Code. \
         Ele expoe o servidor MCP 'shellhive'. Quando precisar que o usuario rode um comando de shell ele mesmo, \
         chame suggest_command em vez de pedir para ele digitar ! comando: o comando vira um botao que roda nesta sessao.",
    );
    if let Some(guide) = crate::plugins::local::guide_path() {
        text.push_str(&format!(
            " Para criar ou editar um plugin do Shellhive quando o usuario pedir, leia antes o guia em {}.",
            guide.display()
        ));
    }
    for extra in crate::plugins::agent_context() {
        text.push(' ');
        text.push_str(&extra);
    }
    serde_json::json!({
        "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": text }
    })
}

/// Events forwarded for state only. PermissionRequest is handled separately
/// because its hook blocks waiting for a decision, and UserPromptSubmit
/// because its hook can stop a Shellhive command from reaching Claude.
const HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionEnd",
];

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Commands Shellhive runs itself when typed in a tab as `:<name>`.
const PROMPT_COMMANDS: &[&str] = &["duplicate"];

/// The Shellhive command a prompt names. Only a prompt that is exactly
/// `:<name>` for a known name counts, so text like `::Class` or `:foo bar`
/// still reaches Claude untouched.
fn prompt_command(payload: &serde_json::Value) -> Option<&'static str> {
    let prompt = payload.get("prompt")?.as_str()?.trim();
    let name = prompt.strip_prefix(':')?;
    PROMPT_COMMANDS.iter().copied().find(|c| *c == name)
}

#[derive(Clone, serde::Serialize)]
struct PromptCommand {
    tab_id: Option<String>,
    name: String,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn next_id() -> String {
    format!("{}-{}", now_millis(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Unique id for other modules that need one.
pub fn next_public_id() -> String {
    next_id()
}

#[derive(Clone, serde::Serialize)]
struct Envelope {
    received_at: u128,
    tab_id: Option<String>,
    payload: serde_json::Value,
}

#[derive(Clone, serde::Serialize)]
struct PermissionRequestEvent {
    id: String,
    received_at: u128,
    tab_id: Option<String>,
    payload: serde_json::Value,
    /// Seconds before Claude Code falls back to its own terminal prompt.
    expires_in: u64,
}

#[derive(Clone, serde::Serialize)]
struct PermissionResolvedEvent {
    id: String,
    decision: Option<String>,
}

#[derive(Clone, serde::Serialize)]
pub struct HookSetup {
    pub hooks_json: String,
    pub forward_sh: String,
    pub statusline_sh: String,
    pub permission_sh: String,
    pub shim_dir: String,
    pub port: u16,
}

fn json_response(value: &serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_data(body).with_header(header)
}

/// How often the server retries a port another process is holding.
const BIND_RETRY: std::time::Duration = std::time::Duration::from_secs(3);

pub fn start_server(app: AppHandle) {
    // Written before the port opens, so no caller finds the file missing.
    token();
    thread::spawn(move || {
        // Another copy of the app (or an older one still open) may hold the
        // port. Giving up would leave hooks, permissions and the editor dead
        // until a restart, so keep trying until it is free.
        let mut warned = false;
        let server = loop {
            match Server::http(("127.0.0.1", PORT)) {
                Ok(s) => break s,
                Err(e) => {
                    if !warned {
                        eprintln!("hook server cannot bind port {PORT} yet: {e}; retrying");
                        crate::errors::record("hooks", &format!("porta {PORT} ocupada: {e}"));
                        warned = true;
                    }
                    thread::sleep(BIND_RETRY);
                }
            }
        };
        if warned {
            eprintln!("hook server bound port {PORT}");
        }
        for request in server.incoming_requests() {
            let app = app.clone();
            // One thread per request: a blocking permission must not stall the rest.
            thread::spawn(move || handle(app, request));
        }
    });
}

/// Puts a permission request in the app's queue and waits for the decision.
/// Claude's hook and the Codex adapter both ask through here, so the queue,
/// the cards over the tab and the group rules work the same for both.
/// `payload` follows Claude Code's shape: `tool_name` and `tool_input`.
pub fn raise_permission(
    app: &AppHandle,
    tab_id: Option<String>,
    payload: serde_json::Value,
    received_at: u128,
    wait: std::time::Duration,
) -> Option<(crate::permissions::Decision, String)> {
    raise_permission_as(app, next_id(), tab_id, payload, received_at, wait)
}

/// `raise_permission` under an id the caller chose, so it can withdraw the
/// request when the agent gets its answer elsewhere.
pub fn raise_permission_as(
    app: &AppHandle,
    id: String,
    tab_id: Option<String>,
    payload: serde_json::Value,
    received_at: u128,
    wait: std::time::Duration,
) -> Option<(crate::permissions::Decision, String)> {
    if let Some(db) = app.try_state::<Db>() {
        let conn = db.0.lock().unwrap();
        crate::db::record_permission_raised(
            &conn,
            &id,
            tab_id.as_deref(),
            &payload,
            received_at as i64,
        );
    }
    let permissions = app.state::<Permissions>().inner().clone();
    permissions.register(&id);
    let _ = app.emit(
        "permission-request",
        PermissionRequestEvent {
            id: id.clone(),
            received_at,
            tab_id: tab_id.clone(),
            payload: payload.clone(),
            expires_in: wait.as_secs(),
        },
    );
    eprintln!(
        "[permission] tab={} tool={} id={}",
        tab_id.as_deref().unwrap_or("-"),
        payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
        id
    );
    let answer = permissions.wait_for(&id, wait);
    let label = answer.as_ref().map(|(d, _)| d.label().to_string());
    if let Some(db) = app.try_state::<Db>() {
        let conn = db.0.lock().unwrap();
        crate::db::record_permission_decided(&conn, &id, label.as_deref());
    }
    let _ = app.emit(
        "permission-resolved",
        PermissionResolvedEvent {
            id,
            decision: label,
        },
    );
    answer
}

/// Hands an event to the app as if a Claude Code hook had sent it: tab state,
/// notifications, plugins and worker bee triggers all read these.
pub fn emit_hook(app: &AppHandle, tab_id: Option<String>, payload: serde_json::Value) {
    let received_at = now_millis();
    if let Some(db) = app.try_state::<Db>() {
        let conn = db.0.lock().unwrap();
        crate::db::record_event(&conn, tab_id.as_deref(), &payload, received_at as i64);
    }
    crate::plugins::events::record(app, tab_id.clone(), received_at as u64, &payload);
    let _ = app.emit(
        "hook-event",
        Envelope {
            received_at,
            tab_id,
            payload,
        },
    );
}

pub fn now_ms() -> u128 {
    now_millis()
}

fn handle(app: AppHandle, mut req: tiny_http::Request) {
    let header = |name: &'static str| {
        req.headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.to_string())
    };
    if !request_allowed(
        header("Origin").as_deref(),
        header("Host").as_deref(),
        header(TOKEN_HEADER).as_deref(),
        token(),
    ) {
        let _ = req.respond(Response::empty(403));
        return;
    }
    // Hooks of another agent (Codex) say which one sent them.
    let provider = header("X-Shellhive-Provider").filter(|p| !p.is_empty());
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let tab_id = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Tab-Id"))
        .map(|h| h.value.to_string())
        .filter(|v| !v.is_empty());
    let mut payload =
        serde_json::from_str(&body).unwrap_or_else(|_| serde_json::Value::String(body.clone()));
    if let (Some(p), Some(obj)) = (provider, payload.as_object_mut()) {
        obj.entry("provider").or_insert(p.into());
    }
    let received_at = now_millis();
    let url = req.url().to_string();

    // Anything else, such as the OAuth discovery Codex tries before using an
    // MCP server, is not for this server; it must not become a hook event.
    const ROUTES: &[&str] = &[
        "/mcp",
        "/permission",
        "/prompt",
        "/session-start",
        "/statusline",
        "/hook",
    ];
    let path = url.split('?').next().unwrap_or("");
    if !ROUTES.contains(&path) {
        let _ = req.respond(Response::empty(404));
        return;
    }
    // MCP clients may open a GET stream for server messages; this server sends none.
    if path == "/mcp" && *req.method() != tiny_http::Method::Post {
        let _ = req.respond(Response::empty(405));
        return;
    }
    if url.starts_with("/mcp") {
        let reply = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|msg| crate::mcp::handle_rpc(&app, tab_id.clone(), &msg));
        match reply {
            Some(value) => {
                let _ = req.respond(json_response(&value));
            }
            // A notification gets an empty acknowledgement.
            None => {
                let _ = req.respond(Response::empty(202));
            }
        }
        return;
    }

    if url.starts_with("/permission") {
        // A question is not a permission: the app already shows it from
        // PreToolUse, and holding it here keeps it out of the terminal.
        if payload.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion") {
            let _ = req.respond(json_response(&serde_json::json!({})));
            return;
        }
        let answer = raise_permission(
            &app,
            tab_id.clone(),
            payload.clone(),
            received_at,
            DECISION_TIMEOUT,
        );
        let response = match &answer {
            Some((decision, reason)) => decision.to_hook_output(reason),
            // No answer in time: stay silent so Claude Code prompts in the terminal.
            None => serde_json::json!({}),
        };
        let _ = req.respond(json_response(&response));
        return;
    }

    // A Shellhive command stops here: the app runs it and Claude never sees
    // the prompt, so it is not recorded as the start of a turn either.
    if url.starts_with("/prompt") {
        if let Some(name) = prompt_command(&payload) {
            let _ = app.emit(
                "prompt-command",
                PromptCommand {
                    tab_id,
                    name: name.to_string(),
                },
            );
            let _ = req.respond(json_response(&serde_json::json!({
                "decision": "block",
                "reason": format!("Shellhive: :{name}"),
            })));
            return;
        }
    }

    // SessionStart is also a hook event; its reply carries the session context.
    let session_start = url.starts_with("/session-start");
    let event = if url.starts_with("/statusline") {
        "statusline-event"
    } else {
        "hook-event"
    };
    if event == "hook-event" {
        eprintln!(
            "[hook] tab={} event={}",
            tab_id.as_deref().unwrap_or("-"),
            payload
                .get("hook_event_name")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
        );
    }
    if event == "hook-event" {
        if let Some(db) = app.try_state::<Db>() {
            let conn = db.0.lock().unwrap();
            crate::db::record_event(&conn, tab_id.as_deref(), &payload, received_at as i64);
        }
        crate::plugins::events::record(&app, tab_id.clone(), received_at as u64, &payload);
    }
    let _ = app.emit(
        event,
        Envelope {
            received_at,
            tab_id,
            payload,
        },
    );
    if session_start {
        let _ = req.respond(json_response(&session_context()));
    } else {
        let _ = req.respond(Response::empty(204));
    }
}

/// Tools that open a panel the user has to act on, so they need no prompt of
/// their own: the core's and every official plugin's.
fn allowed_tools() -> Vec<String> {
    ["list_sessions", "suggest_command"]
        .iter()
        .map(|t| t.to_string())
        .chain(crate::plugins::all_tool_names())
        .map(|t| format!("mcp__shellhive__{t}"))
        .collect()
}

fn config_dir() -> Result<PathBuf, String> {
    crate::paths::data_dir().ok_or_else(|| "no config dir".to_string())
}

/// The statusLine command the user already has in ~/.claude/settings.json, if any.
fn existing_statusline_command() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join("settings.json");
    let text = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let sl = json.get("statusLine")?;
    if sl.get("type").and_then(|t| t.as_str()) != Some("command") {
        return None;
    }
    sl.get("command")
        .and_then(|c| c.as_str())
        .map(str::to_string)
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn write_executable(path: &PathBuf, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Command Claude Code runs for one hook. Unix gets the shell script; Windows,
/// which has no `sh` or `curl` to count on, runs this app's own executable in
/// hook mode (see hookclient.rs), with forward slashes so Git Bash and cmd
/// both read the path the same way.
fn hook_command(kind: &str, script: &std::path::Path) -> String {
    if cfg!(windows) {
        let exe = std::env::current_exe().unwrap_or_default();
        return format!(
            "\"{}\" --hook {kind}",
            exe.to_string_lossy().replace('\\', "/")
        );
    }
    shell_single_quote(&script.to_string_lossy())
}

/// Hook entry point for Codex: runs the Shellhive hook named by its first
/// argument, but only inside a Shellhive tab. Codex reads its hooks from the
/// user's own ~/.codex/hooks.json, so they also run in Codex sessions
/// elsewhere, where this does nothing.
#[cfg(unix)]
fn write_codex_scripts(
    dir: &std::path::Path,
    forward: &std::path::Path,
    permission: &std::path::Path,
    prompt: &std::path::Path,
    session_start: &std::path::Path,
    token_file: &str,
) -> Result<(), String> {
    let q = |p: &std::path::Path| shell_single_quote(&p.to_string_lossy());
    let (forward, permission, prompt, session_start) =
        (q(forward), q(permission), q(prompt), q(session_start));
    write_executable(
        &dir.join("codex_hook.sh"),
        format!(
            "#!/bin/sh\n\
             # Runs a Shellhive hook for Codex, only inside a Shellhive tab.\n\
             [ -n \"${{SHELLHIVE_TAB_ID:-}}\" ] || exit 0\n\
             SHELLHIVE_PROVIDER=codex\n\
             export SHELLHIVE_PROVIDER\n\
             case \"$1\" in\n\
             \x20 permission) exec {permission} ;;\n\
             \x20 prompt) exec {prompt} ;;\n\
             \x20 session-start) exec {session_start} ;;\n\
             \x20 *) exec {forward} ;;\n\
             esac\n"
        ),
    )?;
    // Codex has no hook for its end, so the tab learns of it from here. It
    // also gives Codex the app's MCP server, with the token read from the
    // environment so it never lands in the command line.
    write_executable(
        &dir.join("codex_run.sh"),
        format!(
            "#!/bin/sh\n\
             # Runs codex in a Shellhive tab with the app's MCP server.\n\
             SHELLHIVE_MCP_TOKEN=$(cat {token_file} 2>/dev/null)\n\
             export SHELLHIVE_MCP_TOKEN\n\
             trap : INT\n\
             codex -c 'mcp_servers.shellhive.url=\"http://127.0.0.1:{PORT}/mcp\"' \\\n\
             \x20 -c 'mcp_servers.shellhive.env_http_headers={{\"X-Tab-Id\"=\"SHELLHIVE_TAB_ID\",\"{TOKEN_HEADER}\"=\"SHELLHIVE_MCP_TOKEN\"}}' \\\n\
             \x20 \"$@\"\n\
             status=$?\n\
             printf '{{\"hook_event_name\":\"SessionEnd\"}}' | SHELLHIVE_PROVIDER=codex {forward}\n\
             exit $status\n"
        ),
    )
}

/// The script a tab's `codex` runs through.
pub fn codex_run_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("codex_run.sh"))
}

/// Codex hook events and the Shellhive hook each one runs.
const CODEX_HOOKS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt"),
    ("PreToolUse", "forward"),
    ("PermissionRequest", "permission"),
    ("PostToolUse", "forward"),
    ("Stop", "forward"),
];

/// Adds the Shellhive hooks to Codex's hooks, after the ones already there.
/// Codex trusts hooks by their place in the file, so the others keep theirs.
/// Returns whether the file changed.
fn merge_codex_hooks(file: &mut serde_json::Value, script: &str) -> bool {
    let Some(root) = file.as_object_mut() else {
        return false;
    };
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let Some(hooks) = hooks.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    for (event, kind) in CODEX_HOOKS {
        let command = format!("{} {kind}", shell_single_quote(script));
        let list = hooks.entry(*event).or_insert_with(|| serde_json::json!([]));
        let Some(list) = list.as_array_mut() else {
            continue;
        };
        let present = list.iter().any(|group| {
            group
                .get("hooks")
                .and_then(|h| h.as_array())
                .is_some_and(|hs| {
                    hs.iter().any(|h| {
                        h.get("command").and_then(|c| c.as_str()) == Some(command.as_str())
                    })
                })
        });
        if !present {
            // Long enough for a decision taken in the queue.
            let timeout = if *kind == "permission" {
                DECISION_TIMEOUT.as_secs() + 30
            } else {
                10
            };
            list.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
            changed = true;
        }
    }
    changed
}

/// Puts the Shellhive hooks in ~/.codex/hooks.json, for Codex sessions run in
/// a tab's terminal. Codex asks the user to trust them once.
#[tauri::command]
pub fn codex_hooks_install() -> Result<bool, String> {
    #[cfg(unix)]
    {
        let script = config_dir()?.join("codex_hook.sh");
        let path = dirs::home_dir()
            .ok_or("no home")?
            .join(".codex")
            .join("hooks.json");
        let mut file: serde_json::Value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("~/.codex/hooks.json ilegível: {e}"))?,
            Err(_) => serde_json::json!({}),
        };
        if !merge_codex_hooks(&mut file, &script.to_string_lossy()) {
            return Ok(false);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        fs::write(&path, text + "\n").map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(unix))]
    Err("o Codex no terminal ainda não funciona no Windows".into())
}

/// The settings file every `claude` in a tab is launched with.
pub fn settings_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("hooks.json"))
}

/// Directory holding the `claude` shim, prepended to each tab's PATH so any
/// `claude` typed in a tab carries the app's settings.
pub fn shim_dir() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("bin"))
}

/// Writes the forwarder scripts and a settings file into the app config dir.
/// Claude Code is launched with `--settings <hooks.json>`, so the user's global
/// settings are never modified.
#[tauri::command]
pub fn hooks_setup() -> Result<HookSetup, String> {
    write_scripts()
}

pub fn write_scripts() -> Result<HookSetup, String> {
    let dir = config_dir()?;
    let token_file = shell_single_quote(&token_path().ok_or("no config dir")?.to_string_lossy());
    let forward_sh = dir.join("forward.sh");
    let statusline_sh = dir.join("statusline.sh");
    let permission_sh = dir.join("permission.sh");
    let hooks_json = dir.join("hooks.json");

    write_executable(
        &forward_sh,
        format!(
            "#!/bin/sh\n\
             # Forwards a Claude Code hook payload (JSON on stdin) to Shellhive.\n\
             # Always exits 0 so a missing app never blocks Claude Code.\n\
             curl -s --max-time 2 -X POST \\\n\
             \x20 -H \"Content-Type: application/json\" \\\n\
             \x20 -H \"X-Tab-Id: ${{SHELLHIVE_TAB_ID:-}}\" \\\n\
             \x20 -H \"X-Shellhive-Provider: ${{SHELLHIVE_PROVIDER:-}}\" \\\n\
             \x20 -H \"{TOKEN_HEADER}: $(cat {token_file} 2>/dev/null)\" \\\n\
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/hook\" >/dev/null 2>&1 || true\n\
             exit 0\n"
        ),
    )?;

    // The app holds this request open until someone decides in the queue, then
    // answers with the permission JSON. No answer means empty output, and
    // Claude Code prompts in the terminal as usual.
    let curl_timeout = DECISION_TIMEOUT.as_secs() + 10;
    write_executable(
        &permission_sh,
        format!(
            "#!/bin/sh\n\
             # Asks Shellhive to decide a permission request.\n\
             out=$(curl -s --max-time {curl_timeout} -X POST \\\n\
             \x20 -H \"Content-Type: application/json\" \\\n\
             \x20 -H \"X-Tab-Id: ${{SHELLHIVE_TAB_ID:-}}\" \\\n\
             \x20 -H \"X-Shellhive-Provider: ${{SHELLHIVE_PROVIDER:-}}\" \\\n\
             \x20 -H \"{TOKEN_HEADER}: $(cat {token_file} 2>/dev/null)\" \\\n\
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/permission\" 2>/dev/null)\n\
             case \"$out\" in\n\
             \x20 *permissionDecision*) printf '%s' \"$out\" ;;\n\
             esac\n\
             exit 0\n"
        ),
    )?;

    // Waits for the app's reply, which stops the prompt when it is a
    // Shellhive command. Every other prompt passes as soon as the app answers.
    let prompt_sh = dir.join("prompt.sh");
    write_executable(
        &prompt_sh,
        format!(
            "#!/bin/sh\n\
             # Forwards UserPromptSubmit; the app may answer with a block.\n\
             out=$(curl -s --max-time 2 -X POST \\\n\
             \x20 -H \"Content-Type: application/json\" \\\n\
             \x20 -H \"X-Tab-Id: ${{SHELLHIVE_TAB_ID:-}}\" \\\n\
             \x20 -H \"X-Shellhive-Provider: ${{SHELLHIVE_PROVIDER:-}}\" \\\n\
             \x20 -H \"{TOKEN_HEADER}: $(cat {token_file} 2>/dev/null)\" \\\n\
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/prompt\" 2>/dev/null)\n\
             case \"$out\" in\n\
             \x20 *decision*) printf '%s' \"$out\" ;;\n\
             esac\n\
             exit 0\n"
        ),
    )?;

    let session_start_sh = dir.join("session_start.sh");
    write_executable(
        &session_start_sh,
        format!(
            "#!/bin/sh\n\
             # Forwards SessionStart; the app answers with what to tell Claude.\n\
             input=$(cat)\n\
             printf '%s' \"$input\" | curl -s --max-time 2 -X POST \\\n\
             \x20 -H \"Content-Type: application/json\" \\\n\
             \x20 -H \"X-Tab-Id: ${{SHELLHIVE_TAB_ID:-}}\" \\\n\
             \x20 -H \"X-Shellhive-Provider: ${{SHELLHIVE_PROVIDER:-}}\" \\\n\
             \x20 -H \"{TOKEN_HEADER}: $(cat {token_file} 2>/dev/null)\" \\\n\
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/session-start\" 2>/dev/null || true\n\
             exit 0\n"
        ),
    )?;

    let original = existing_statusline_command()
        .map(|c| shell_single_quote(&c))
        .unwrap_or_else(|| "''".to_string());
    write_executable(
        &statusline_sh,
        format!(
            "#!/bin/sh\n\
             # Mirrors Claude Code statusline JSON to Shellhive, then runs the\n\
             # user's original statusline command (captured when this file was written).\n\
             input=$(cat)\n\
             printf '%s' \"$input\" | curl -s --max-time 2 -X POST \\\n\
             \x20 -H \"Content-Type: application/json\" \\\n\
             \x20 -H \"X-Tab-Id: ${{SHELLHIVE_TAB_ID:-}}\" \\\n\
             \x20 -H \"{TOKEN_HEADER}: $(cat {token_file} 2>/dev/null)\" \\\n\
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/statusline\" >/dev/null 2>&1 || true\n\
             ORIG={original}\n\
             if [ -n \"$ORIG\" ]; then\n\
             \x20 printf '%s' \"$input\" | sh -c \"$ORIG\"\n\
             fi\n\
             exit 0\n"
        ),
    )?;

    let forward_command = hook_command("forward", &forward_sh);
    let mut hooks = serde_json::Map::new();
    hooks.insert(
        "SessionStart".to_string(),
        serde_json::json!([{
            "hooks": [{
                "type": "command",
                "command": hook_command("session-start", &session_start_sh),
            }]
        }]),
    );
    hooks.insert(
        "UserPromptSubmit".to_string(),
        serde_json::json!([{
            "hooks": [{ "type": "command", "command": hook_command("prompt", &prompt_sh) }]
        }]),
    );
    for event in HOOK_EVENTS {
        hooks.insert(
            event.to_string(),
            serde_json::json!([{ "hooks": [{ "type": "command", "command": forward_command }] }]),
        );
    }
    hooks.insert(
        "PermissionRequest".to_string(),
        serde_json::json!([{
            "hooks": [{
                "type": "command",
                "command": hook_command("permission", &permission_sh),
                "timeout": curl_timeout + 10,
            }]
        }]),
    );

    let settings = serde_json::json!({
        "permissions": {
            "allow": allowed_tools()
        },
        "hooks": hooks,
        "statusLine": {
            "type": "command",
            "command": hook_command("statusline", &statusline_sh),
        }
    });
    fs::write(
        &hooks_json,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    // A shim earlier in PATH than the real binary, so `claude` typed by hand in
    // a tab gets the same settings the app would pass. It re-resolves the real
    // binary from a PATH with this directory removed, which keeps it working
    // whatever version manager installed Claude Code.
    let mcp_json = dir.join("mcp.json");
    // Holds the token, so only the user may read it.
    write_private(
        &mcp_json,
        &serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": {
                "shellhive": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{PORT}/mcp"),
                    "headers": { TOKEN_HEADER: token() },
                }
            }
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let bin_dir = shim_dir().ok_or("no config dir")?;
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let shim = bin_dir.join("claude");
    // Windows cannot run this sh script; PowerShell would find it first and
    // ask which program opens it. Remove the one older versions wrote.
    if cfg!(windows) {
        let _ = fs::remove_file(&shim);
    } else {
        write_executable(
        &shim,
        format!(
            "#!/bin/sh\n\
             # Generated by Shellhive. Adds this app's hooks to every run.\n\
             SHIM_DIR={shim_dir}\n\
             CLEAN_PATH=$(printf '%s' \"$PATH\" | awk -v d=\"$SHIM_DIR\" -F: '{{for(i=1;i<=NF;i++) if($i!=d) printf \"%s%s\", (o++?\":\":\"\"), $i}}')\n\
             REAL=$(PATH=\"$CLEAN_PATH\" command -v claude) || {{\n\
             \x20 echo 'claude nao encontrado no PATH' >&2\n\
             \x20 exit 127\n\
             }}\n\
             MCP={mcp}\n\
             # Claude Code does not expand variables in a --mcp-config file, so a\n\
             # tab gets its own copy with its id written in, for the MCP server\n\
             # to know which tab a tool call comes from.\n\
             if [ -n \"${{SHELLHIVE_TAB_ID:-}}\" ]; then\n\
             \x20 TAB_MCP=\"${{TMPDIR:-/tmp}}/shellhive-mcp-$SHELLHIVE_TAB_ID.json\"\n\
             \x20 # It carries the token: written fresh and readable only by the user,\n\
             \x20 # since /tmp is shared on Linux.\n\
             \x20 rm -f \"$TAB_MCP\"\n\
             \x20 (umask 077 && printf '{{\"mcpServers\":{{\"shellhive\":{{\"type\":\"http\",\"url\":\"http://127.0.0.1:{PORT}/mcp\",\"headers\":{{\"X-Tab-Id\":\"%s\",\"{TOKEN_HEADER}\":\"%s\"}}}}}}}}' \"$SHELLHIVE_TAB_ID\" \"$(cat {token_file} 2>/dev/null)\" > \"$TAB_MCP\") && MCP=\"$TAB_MCP\"\n\
             fi\n\
             # A tab whose group sets a model or permission mode has its own\n\
             # copy of the settings, written by the app when the tab opened.\n\
             SETTINGS=${{SHELLHIVE_SETTINGS:-{settings}}}\n\
             # The app's options go last: --mcp-config takes every word after it\n\
             # as another file, so a prompt placed after it would be read as one.\n\
             exec \"$REAL\" \"$@\" --settings \"$SETTINGS\" --mcp-config \"$MCP\"\n",
            shim_dir = shell_single_quote(&bin_dir.to_string_lossy()),
            settings = shell_single_quote(&hooks_json.to_string_lossy()),
            mcp = shell_single_quote(&mcp_json.to_string_lossy()),
        ),
    )?;
    }

    #[cfg(unix)]
    write_codex_scripts(
        &dir,
        &forward_sh,
        &permission_sh,
        &prompt_sh,
        &session_start_sh,
        &token_file,
    )?;

    Ok(HookSetup {
        hooks_json: hooks_json.to_string_lossy().to_string(),
        forward_sh: forward_sh.to_string_lossy().to_string(),
        statusline_sh: statusline_sh.to_string_lossy().to_string(),
        permission_sh: permission_sh.to_string_lossy().to_string(),
        shim_dir: bin_dir.to_string_lossy().to_string(),
        port: PORT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_of(prompt: &str) -> Option<&'static str> {
        prompt_command(&serde_json::json!({ "prompt": prompt }))
    }

    /// Only a prompt that is exactly `:<known name>` is taken from Claude.
    #[test]
    fn only_an_exact_command_is_stopped() {
        assert_eq!(command_of(":duplicate"), Some("duplicate"));
        assert_eq!(command_of("  :duplicate\n"), Some("duplicate"));
        assert_eq!(command_of("::Class"), None);
        assert_eq!(command_of("::duplicate"), None);
        assert_eq!(command_of(":duplicate this file"), None);
        assert_eq!(command_of(":unknown"), None);
        assert_eq!(command_of("duplicate"), None);
        assert_eq!(command_of("use :duplicate"), None);
    }

    fn host() -> String {
        format!("127.0.0.1:{PORT}")
    }

    /// Hooks, the shim and the MCP client pass with the token and no Origin.
    #[test]
    fn a_local_caller_with_the_token_passes() {
        assert!(request_allowed(None, Some(&host()), Some("abc"), "abc"));
        let localhost = format!("localhost:{PORT}");
        assert!(request_allowed(None, Some(&localhost), Some("abc"), "abc"));
    }

    /// A missing or wrong token is refused.
    #[test]
    fn a_caller_without_the_token_is_refused() {
        assert!(!request_allowed(None, Some(&host()), None, "abc"));
        assert!(!request_allowed(None, Some(&host()), Some("abd"), "abc"));
        assert!(!request_allowed(None, Some(&host()), Some("ab"), "abc"));
        assert!(!request_allowed(None, Some(&host()), Some(""), "abc"));
    }

    /// A browser sends Origin; a rebound DNS name shows up in Host.
    #[test]
    fn a_browser_is_refused_even_with_the_token() {
        assert!(!request_allowed(
            Some("https://evil.example"),
            Some(&host()),
            Some("abc"),
            "abc"
        ));
        assert!(!request_allowed(
            Some("null"),
            Some(&host()),
            Some("abc"),
            "abc"
        ));
        assert!(!request_allowed(
            None,
            Some("evil.example:47831"),
            Some("abc"),
            "abc"
        ));
        assert!(!request_allowed(None, None, Some("abc"), "abc"));
    }

    #[test]
    fn codex_hooks_go_after_the_users_and_only_once() {
        let mut file = serde_json::json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "other", "timeout": 10 }] }] } });
        assert!(merge_codex_hooks(&mut file, "/x/codex_hook.sh"));
        assert!(!merge_codex_hooks(&mut file, "/x/codex_hook.sh"));
        let stop = file["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop[0]["hooks"][0]["command"], "other");
        assert_eq!(stop[1]["hooks"][0]["command"], "'/x/codex_hook.sh' forward");
        assert_eq!(
            file["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"],
            DECISION_TIMEOUT.as_secs() + 30
        );
    }

    /// codex_run.sh passes the arguments and the MCP server on to codex, with
    /// the token in the environment, then reports the end as a Codex hook.
    /// codex_hook.sh does nothing outside a tab.
    #[cfg(unix)]
    #[test]
    fn codex_scripts_run_codex_and_report_its_end() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("shellhive-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        let log = dir.join("log");
        let logq = shell_single_quote(&log.to_string_lossy());
        // Stand-ins for codex and the forwarder, writing what they get.
        write_executable(
            &dir.join("bin/codex"),
            format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {logq}; done\necho \"token=$SHELLHIVE_MCP_TOKEN\" >> {logq}\nexit 3\n"),
        )
        .unwrap();
        let fwd = dir.join("forward.sh");
        write_executable(
            &fwd,
            format!("#!/bin/sh\necho \"end provider=$SHELLHIVE_PROVIDER $(cat)\" >> {logq}\n"),
        )
        .unwrap();
        fs::write(dir.join("token"), "tok123").unwrap();
        let token_file = shell_single_quote(&dir.join("token").to_string_lossy());
        write_codex_scripts(&dir, &fwd, &fwd, &fwd, &fwd, &token_file).unwrap();

        let path = format!(
            "{}:{}",
            dir.join("bin").to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        );
        let status = Command::new(dir.join("codex_run.sh"))
            .args(["resume", "abc"])
            .env("PATH", &path)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(3));
        let out = fs::read_to_string(&log).unwrap();
        assert!(
            out.contains("mcp_servers.shellhive.url=\"http://127.0.0.1:"),
            "{out}"
        );
        assert!(out.contains("\"X-Tab-Id\"=\"SHELLHIVE_TAB_ID\""), "{out}");
        assert!(out.contains("resume\nabc\ntoken=tok123\n"), "{out}");
        assert!(
            out.contains("end provider=codex {\"hook_event_name\":\"SessionEnd\"}"),
            "{out}"
        );

        fs::write(&log, "").unwrap();
        let mut hook = Command::new(dir.join("codex_hook.sh"))
            .arg("forward")
            .env_remove("SHELLHIVE_TAB_ID")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        drop(hook.stdin.take());
        hook.wait().unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), "");
        let mut hook = Command::new(dir.join("codex_hook.sh"))
            .arg("forward")
            .env("SHELLHIVE_TAB_ID", "t1")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        {
            use std::io::Write;
            hook.stdin.take().unwrap().write_all(b"{}").unwrap();
        }
        hook.wait().unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), "end provider=codex {}\n");
        fs::remove_dir_all(&dir).ok();
    }
}
