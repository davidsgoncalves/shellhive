//! Plugins the user makes, usually by asking the agent to write one, in
//! `plugins/<id>/` inside the app's data folder. A folder is scanned every
//! few seconds; a new or changed plugin waits for the user's approval of
//! exactly the files it has, and only an approved one can be turned on.
//! Its tools run as programs from its folder; its optional panel is a single
//! HTML file shown in an isolated frame.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::mcp::text_result;

const SCAN_EVERY: Duration = Duration::from_secs(2);
const RUN_TIMEOUT: Duration = Duration::from_secs(60);
/// Output past this is cut, so a runaway program cannot flood the agent.
const OUTPUT_MAX: usize = 256 * 1024;
/// Files past this are hashed by size alone.
const HASH_FILE_MAX: u64 = 4 * 1024 * 1024;

const GUIDE: &str = include_str!("../../plugin-kit/GUIDE.md");
const EXAMPLE: &[(&str, &str)] = &[
    (
        "plugin.json",
        include_str!("../../plugin-kit/exemplo/plugin.json"),
    ),
    ("ola.js", include_str!("../../plugin-kit/exemplo/ola.js")),
    (
        "panel.html",
        include_str!("../../plugin-kit/exemplo/panel.html"),
    ),
];

#[derive(Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Approved,
    Pending,
    Invalid,
}

#[derive(Clone, serde::Serialize)]
pub struct ToolInfo {
    name: String,
    description: String,
    run: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
pub struct PanelInfo {
    title: String,
    #[serde(skip)]
    entry: String,
}

/// A plugin found in the folder, as the interface shows it.
#[derive(Clone, serde::Serialize)]
pub struct LocalPlugin {
    id: String,
    name: String,
    description: String,
    status: Status,
    error: Option<String>,
    /// Fingerprint of every file in the folder; approval is tied to it.
    hash: String,
    dir: String,
    tools: Vec<ToolInfo>,
    panel: Option<PanelInfo>,
    permissions: Vec<String>,
    #[serde(skip)]
    agent_context: Option<String>,
    /// MCP definitions of the tools, without the `run` field.
    #[serde(skip)]
    definitions: Vec<serde_json::Value>,
}

static FOUND: Mutex<Vec<LocalPlugin>> = Mutex::new(Vec::new());

pub fn root() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("plugins"))
}

pub fn guide_path() -> Option<PathBuf> {
    Some(root()?.join("GUIDE.md"))
}

fn approvals_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("plugin-approvals.json"))
}

fn approvals() -> HashMap<String, String> {
    approvals_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_approvals(map: &HashMap<String, String>) -> Result<(), String> {
    let path = approvals_path().ok_or("no config dir")?;
    fs::write(path, serde_json::to_string_pretty(map).unwrap()).map_err(|e| e.to_string())
}

/// FNV-1a: stable across builds, so an approval survives app updates.
fn fnv(hash: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *hash ^= *b as u64;
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn collect(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_path_buf());
        }
    }
}

fn fingerprint(dir: &Path) -> String {
    let mut files = Vec::new();
    collect(dir, dir, &mut files);
    files.sort();
    let mut hash: u64 = 0xcbf29ce484222325;
    for rel in files {
        fnv(&mut hash, rel.to_string_lossy().as_bytes());
        let path = dir.join(&rel);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        fnv(&mut hash, &size.to_le_bytes());
        if size <= HASH_FILE_MAX {
            if let Ok(bytes) = fs::read(&path) {
                fnv(&mut hash, &bytes);
            }
        }
    }
    format!("{hash:016x}")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Reads and checks one plugin folder. An error keeps the plugin listed, so
/// the user and the agent can see what to fix.
fn read_plugin(dir: &Path, id: &str, approved: &HashMap<String, String>) -> LocalPlugin {
    let hash = fingerprint(dir);
    let mut plugin = LocalPlugin {
        id: id.to_string(),
        name: id.to_string(),
        description: String::new(),
        status: Status::Invalid,
        error: None,
        hash: hash.clone(),
        dir: dir.to_string_lossy().to_string(),
        tools: Vec::new(),
        panel: None,
        permissions: Vec::new(),
        agent_context: None,
        definitions: Vec::new(),
    };
    match parse(dir, id, &mut plugin) {
        Ok(()) => {
            plugin.status = if approved.get(id) == Some(&hash) {
                Status::Approved
            } else {
                Status::Pending
            };
        }
        Err(e) => plugin.error = Some(e),
    }
    plugin
}

const PERMISSIONS: &[&str] = &["tab", "tools", "prompt", "storage"];

fn parse(dir: &Path, id: &str, plugin: &mut LocalPlugin) -> Result<(), String> {
    if !valid_id(id) {
        return Err("o nome da pasta precisa ter só letras minúsculas, números e hífen".into());
    }
    if super::is_official(id) {
        return Err(format!("{id} é o nome de um plugin oficial"));
    }
    let raw = fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| "falta o arquivo plugin.json".to_string())?;
    let m: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json inválido: {e}"))?;
    if text(&m, "id").as_deref() != Some(id) {
        return Err(format!(
            "o campo id do plugin.json precisa ser \"{id}\", o nome da pasta"
        ));
    }
    plugin.name = text(&m, "name").ok_or("falta o campo name")?;
    plugin.description = text(&m, "description").unwrap_or_default();
    plugin.agent_context = text(&m, "agentContext");

    for tool in m
        .get("tools")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
    {
        let name = text(tool, "name").ok_or("uma ferramenta está sem name")?;
        if !name.starts_with(&format!("{id}_")) {
            return Err(format!("a ferramenta {name} precisa começar com {id}_"));
        }
        let description =
            text(tool, "description").ok_or(format!("{name} está sem description"))?;
        let run: Vec<String> = tool
            .get("run")
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if run.is_empty() {
            return Err(format!(
                "{name} precisa de run, uma lista como [\"node\", \"arquivo.js\"]"
            ));
        }
        let schema = tool
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "type": "object" }));
        plugin.definitions.push(serde_json::json!({
            "name": name, "description": description, "inputSchema": schema,
        }));
        plugin.tools.push(ToolInfo {
            name,
            description,
            run,
        });
    }

    if let Some(panel) = m.get("panel") {
        let entry = text(panel, "entry").unwrap_or_else(|| "panel.html".into());
        if entry.contains(['/', '\\']) || entry.starts_with('.') {
            return Err("panel.entry precisa ser um arquivo na pasta do plugin".into());
        }
        if !dir.join(&entry).is_file() {
            return Err(format!("o painel aponta para {entry}, que não existe"));
        }
        let title = text(panel, "title").unwrap_or_else(|| plugin.name.clone());
        plugin.panel = Some(PanelInfo { title, entry });
    }

    for p in m
        .get("permissions")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
    {
        let p = p.as_str().unwrap_or_default();
        if !PERMISSIONS.contains(&p) {
            return Err(format!(
                "permissão desconhecida: {p}; use {}",
                PERMISSIONS.join(", ")
            ));
        }
        plugin.permissions.push(p.to_string());
    }
    if plugin.tools.is_empty() && plugin.panel.is_none() {
        return Err("o plugin precisa de ao menos uma ferramenta ou um painel".into());
    }
    Ok(())
}

fn scan() -> Vec<LocalPlugin> {
    let Some(root) = root() else {
        return Vec::new();
    };
    let approved = approvals();
    let mut found: Vec<LocalPlugin> = fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // _exemplo and hidden folders are not plugins.
            (!name.starts_with('_') && !name.starts_with('.'))
                .then(|| read_plugin(&e.path(), &name, &approved))
        })
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn signature(list: &[LocalPlugin]) -> Vec<(String, String, String)> {
    list.iter()
        .map(|p| (p.id.clone(), p.hash.clone(), format!("{:?}", p.error)))
        .collect()
}

fn refresh(app: &AppHandle) {
    let list = scan();
    let mut found = FOUND.lock().unwrap();
    let changed = signature(&found) != signature(&list)
        || found
            .iter()
            .map(|p| &p.status)
            .ne(list.iter().map(|p| &p.status));
    *found = list.clone();
    drop(found);
    if changed {
        let _ = app.emit("local-plugins", list);
    }
}

/// Writes the guide and the example, then keeps watching the folder.
pub fn start(app: AppHandle) {
    if let Some(root) = root() {
        let _ = fs::create_dir_all(&root);
        let _ = fs::write(root.join("GUIDE.md"), GUIDE);
        let example = root.join("_exemplo");
        let _ = fs::create_dir_all(&example);
        for (name, body) in EXAMPLE {
            let _ = fs::write(example.join(name), body);
        }
    }
    thread::spawn(move || loop {
        refresh(&app);
        thread::sleep(SCAN_EVERY);
    });
}

fn approved(id: &str) -> Option<LocalPlugin> {
    FOUND
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.id == id && p.status == Status::Approved)
        .cloned()
}

/// Approved plugins, for the registry to filter by what the user turned on.
pub fn approved_plugins() -> Vec<(String, Vec<serde_json::Value>, Option<String>)> {
    FOUND
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p.status == Status::Approved)
        .map(|p| (p.id.clone(), p.definitions.clone(), p.agent_context.clone()))
        .collect()
}

pub fn is_local(id: &str) -> bool {
    FOUND.lock().unwrap().iter().any(|p| p.id == id)
}

/// Where local plugins live, and the guide the agent reads to write one.
#[tauri::command]
pub fn local_plugins_folder() -> Option<String> {
    root().map(|r| r.to_string_lossy().to_string())
}

#[tauri::command]
pub fn local_plugins() -> Vec<LocalPlugin> {
    FOUND.lock().unwrap().clone()
}

/// Approves the plugin as the user saw it: a change since then is refused.
#[tauri::command]
pub fn local_plugin_approve(app: AppHandle, id: String, hash: String) -> Result<(), String> {
    let dir = root().ok_or("no config dir")?.join(&id);
    if fingerprint(&dir) != hash {
        return Err("o plugin mudou depois que você o viu; confira de novo".into());
    }
    let mut map = approvals();
    map.insert(id, hash);
    save_approvals(&map)?;
    refresh(&app);
    Ok(())
}

/// Deletes the plugin's folder and forgets its approval and data.
#[tauri::command]
pub fn local_plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("plugin inválido".into());
    }
    let dir = root().ok_or("no config dir")?.join(&id);
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut map = approvals();
    map.remove(&id);
    save_approvals(&map)?;
    if let Some(data) = storage_path(&id) {
        let _ = fs::remove_file(data);
    }
    refresh(&app);
    Ok(())
}

/// The HTML of an approved plugin's panel.
#[tauri::command]
pub fn local_plugin_panel(id: String) -> Result<String, String> {
    let plugin = approved(&id).ok_or("plugin não aprovado")?;
    let panel = plugin.panel.ok_or("o plugin não tem painel")?;
    fs::read_to_string(Path::new(&plugin.dir).join(panel.entry)).map_err(|e| e.to_string())
}

fn storage_path(id: &str) -> Option<PathBuf> {
    Some(
        crate::paths::data_dir()?
            .join("plugin-data")
            .join(format!("{id}.json")),
    )
}

#[tauri::command]
pub fn plugin_storage_get(id: String) -> serde_json::Value {
    storage_path(&id)
        .filter(|_| valid_id(&id))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn plugin_storage_set(id: String, value: serde_json::Value) -> Result<(), String> {
    if approved(&id).is_none() {
        return Err("plugin não aprovado".into());
    }
    let path = storage_path(&id).ok_or("no config dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    if body.len() > OUTPUT_MAX {
        return Err("dados grandes demais para o armazenamento do plugin".into());
    }
    fs::write(path, body).map_err(|e| e.to_string())
}

fn read_all(mut from: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let _ = from
            .by_ref()
            .take(OUTPUT_MAX as u64 + 1)
            .read_to_end(&mut out);
        out
    })
}

/// Runs a tool's program with the arguments as JSON on stdin. Plain output
/// goes back as text; a JSON object with `text` may also set `isError` and
/// `panel`, which opens the plugin's panel with that data.
pub fn call(
    app: &AppHandle,
    id: &str,
    tool: &str,
    tab_id: Option<String>,
    args: &serde_json::Value,
) -> serde_json::Value {
    let Some(plugin) = approved(id) else {
        return text_result(format!("O plugin {id} não está aprovado."), true);
    };
    let (result, panel) = run_tool(&plugin, tool, tab_id.as_deref(), args);
    if let Some(data) = panel {
        let _ = app.emit(
            "plugin-panel-open",
            serde_json::json!({ "plugin": id, "tab_id": tab_id, "data": data }),
        );
    }
    result
}

/// A tool called from the plugin's own panel; the reply comes back as
/// `{ text, isError }` and is not shown to the agent.
#[tauri::command]
pub async fn local_plugin_run(
    id: String,
    tool: String,
    tab_id: Option<String>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let plugin = approved(&id).ok_or("plugin não aprovado")?;
    let (result, _) = tauri::async_runtime::spawn_blocking(move || {
        run_tool(&plugin, &tool, tab_id.as_deref(), &args)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "text": result["content"][0]["text"],
        "isError": result["isError"],
    }))
}

/// Runs the program and returns the tool result, plus the data for the
/// plugin's panel when the reply asks to open it.
fn run_tool(
    plugin: &LocalPlugin,
    tool: &str,
    tab_id: Option<&str>,
    args: &serde_json::Value,
) -> (serde_json::Value, Option<serde_json::Value>) {
    let fail = |text: String| (text_result(text, true), None);
    let Some(spec) = plugin.tools.iter().find(|t| t.name == tool) else {
        return fail(format!("O plugin {} não tem {tool}.", plugin.id));
    };
    let mut cmd = Command::new(&spec.run[0]);
    cmd.args(&spec.run[1..])
        .current_dir(&plugin.dir)
        .env("SHELLHIVE_PLUGIN_DIR", &plugin.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(tab) = tab_id {
        cmd.env("SHELLHIVE_TAB_ID", tab);
        if let Some(cwd) = crate::pty::tab_cwd(tab) {
            cmd.env("SHELLHIVE_TAB_CWD", cwd);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("Não consegui rodar {}: {e}", spec.run.join(" "))),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(args.to_string().as_bytes());
    }
    let out = read_all(child.stdout.take().unwrap());
    let err = read_all(child.stderr.take().unwrap());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => break None,
        }
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).to_string();
    let Some(status) = status else {
        return fail(format!(
            "{tool} passou de {}s e foi encerrado.",
            RUN_TIMEOUT.as_secs()
        ));
    };
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return fail(format!("{tool} falhou ({status}):\n{}", detail.trim()));
    }

    let reply = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .filter(|v| v.get("text").is_some_and(|t| t.is_string()));
    let Some(reply) = reply else {
        return (text_result(stdout.trim().to_string(), false), None);
    };
    let panel = reply
        .get("panel")
        .filter(|_| plugin.panel.is_some())
        .cloned();
    let result = text_result(
        reply["text"].as_str().unwrap_or_default().to_string(),
        reply
            .get("isError")
            .and_then(|e| e.as_bool())
            .unwrap_or(false),
    );
    (result, panel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, files: &[(&str, &str)]) {
        fs::create_dir_all(dir).unwrap();
        for (name, body) in files {
            fs::write(dir.join(name), body).unwrap();
        }
    }

    #[test]
    fn the_bundled_example_is_valid() {
        let tmp = std::env::temp_dir().join(format!("shellhive-kit-{}", std::process::id()));
        let dir = tmp.join("exemplo");
        write(&dir, EXAMPLE);
        let p = read_plugin(&dir, "exemplo", &HashMap::new());
        let _ = fs::remove_dir_all(&tmp);
        assert_eq!(p.error, None);
        assert!(p.status == Status::Pending);
        assert!(p.panel.is_some());
    }

    #[test]
    fn the_example_tool_runs_and_opens_its_panel() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let tmp = std::env::temp_dir().join(format!("shellhive-run-{}", std::process::id()));
        let dir = tmp.join("exemplo");
        write(&dir, EXAMPLE);
        let p = read_plugin(&dir, "exemplo", &HashMap::new());
        let (result, panel) = run_tool(
            &p,
            "exemplo_ola",
            None,
            &serde_json::json!({ "nome": "Ana" }),
        );
        let _ = fs::remove_dir_all(&tmp);
        assert_eq!(result["isError"], false, "{result}");
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Ana"));
        assert!(panel.unwrap()["mensagem"].as_str().unwrap().contains("Ana"));
    }

    #[test]
    fn approval_is_tied_to_the_files() {
        let tmp = std::env::temp_dir().join(format!("shellhive-hash-{}", std::process::id()));
        let dir = tmp.join("demo");
        write(
            &dir,
            &[(
                "plugin.json",
                r#"{"id":"demo","name":"Demo","tools":[{"name":"demo_x","description":"d","run":["true"]}]}"#,
            )],
        );
        let hash = fingerprint(&dir);
        let approved = HashMap::from([("demo".to_string(), hash)]);
        assert!(read_plugin(&dir, "demo", &approved).status == Status::Approved);
        fs::write(dir.join("extra.js"), "changed").unwrap();
        assert!(read_plugin(&dir, "demo", &approved).status == Status::Pending);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tools_must_carry_the_plugin_prefix() {
        let tmp = std::env::temp_dir().join(format!("shellhive-prefix-{}", std::process::id()));
        let dir = tmp.join("demo");
        write(
            &dir,
            &[(
                "plugin.json",
                r#"{"id":"demo","name":"Demo","tools":[{"name":"open_editor","description":"d","run":["true"]}]}"#,
            )],
        );
        let p = read_plugin(&dir, "demo", &HashMap::new());
        let _ = fs::remove_dir_all(&tmp);
        assert!(p.status == Status::Invalid);
        assert!(p.error.unwrap().contains("demo_"));
    }
}
