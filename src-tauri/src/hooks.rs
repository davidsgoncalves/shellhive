use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Response, Server};

use crate::db::Db;
use crate::permissions::{Permissions, DECISION_TIMEOUT};

pub const PORT: u16 = 47831;

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
/// because its hook blocks waiting for a decision.
const HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionEnd",
];

static SEQ: AtomicU64 = AtomicU64::new(0);

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

fn handle(app: AppHandle, mut req: tiny_http::Request) {
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let tab_id = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Tab-Id"))
        .map(|h| h.value.to_string())
        .filter(|v| !v.is_empty());
    let payload =
        serde_json::from_str(&body).unwrap_or_else(|_| serde_json::Value::String(body.clone()));
    let received_at = now_millis();
    let url = req.url().to_string();

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
        let id = next_id();
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
                expires_in: DECISION_TIMEOUT.as_secs(),
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

        let answer = permissions.wait(&id);
        let (response, label) = match &answer {
            Some((decision, reason)) => {
                let json = decision.to_hook_output(reason);
                let label = json["hookSpecificOutput"]["permissionDecision"]
                    .as_str()
                    .unwrap_or("?")
                    .to_string();
                (json, Some(label))
            }
            // No answer in time: stay silent so Claude Code prompts in the terminal.
            None => (serde_json::json!({}), None),
        };
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
        let _ = req.respond(json_response(&response));
        return;
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

/// The settings file every `claude` in a tab is launched with.
#[cfg(windows)]
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
             \x20 --data-binary @- \"http://127.0.0.1:{PORT}/permission\" 2>/dev/null)\n\
             case \"$out\" in\n\
             \x20 *permissionDecision*) printf '%s' \"$out\" ;;\n\
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
    fs::write(
        &mcp_json,
        serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": {
                "shellhive": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{PORT}/mcp"),
                }
            }
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let bin_dir = shim_dir().ok_or("no config dir")?;
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let shim = bin_dir.join("claude");
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
             \x20 printf '{{\"mcpServers\":{{\"shellhive\":{{\"type\":\"http\",\"url\":\"http://127.0.0.1:{PORT}/mcp\",\"headers\":{{\"X-Tab-Id\":\"%s\"}}}}}}}}' \"$SHELLHIVE_TAB_ID\" > \"$TAB_MCP\" && MCP=\"$TAB_MCP\"\n\
             fi\n\
             exec \"$REAL\" --settings {settings} --mcp-config \"$MCP\" \"$@\"\n",
            shim_dir = shell_single_quote(&bin_dir.to_string_lossy()),
            settings = shell_single_quote(&hooks_json.to_string_lossy()),
            mcp = shell_single_quote(&mcp_json.to_string_lossy()),
        ),
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
