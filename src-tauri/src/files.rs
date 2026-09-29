use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Drops `:line` and `:line:col` suffixes, which editors print after paths.
fn strip_position(target: &str) -> &str {
    let mut rest = target;
    for _ in 0..2 {
        match rest.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
                rest = head
            }
            _ => break,
        }
    }
    rest
}

fn resolve(target: &str, cwd: Option<&str>) -> PathBuf {
    let raw = strip_position(target);
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    let p = Path::new(raw);
    match cwd {
        Some(dir) if p.is_relative() => Path::new(dir).join(p),
        _ => p.to_path_buf(),
    }
}

/// Opens a link clicked in a terminal: a web URL in the browser, a file path
/// (absolute, or relative to the tab's folder) with its default app.
#[tauri::command]
pub fn link_open(app: AppHandle, target: String, cwd: Option<String>) -> Result<(), String> {
    let web = target.starts_with("http://") || target.starts_with("https://");
    if web && crate::paths::is_wsl() {
        return open_on_windows(&target);
    }
    if web {
        return app
            .opener()
            .open_url(target, None::<&str>)
            .map_err(|e| e.to_string());
    }
    let path = match target.strip_prefix("file://") {
        Some(rest) => PathBuf::from(rest.trim_start_matches("localhost")),
        None => resolve(&target, cwd.as_deref()),
    };
    if !path.exists() {
        return Err(format!("{} não existe", path.display()));
    }
    if crate::paths::is_wsl() {
        return open_on_windows(&path.to_string_lossy());
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Inside WSL there is usually no Linux browser or file handler, so links go
/// to Windows: through wslview when installed, else through explorer.exe with
/// the path translated to its Windows form.
fn open_on_windows(target: &str) -> Result<(), String> {
    use std::process::Command;
    if Command::new("wslview").arg(target).spawn().is_ok() {
        return Ok(());
    }
    let windows_target = if target.starts_with('/') {
        Command::new("wslpath")
            .args(["-w", target])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| target.to_string())
    } else {
        target.to_string()
    };
    Command::new("explorer.exe")
        .arg(windows_target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("não consegui abrir no Windows: {e}"))
}

/// True when the text points at an existing file, so it is worth underlining.
#[tauri::command]
pub fn path_exists(target: String, cwd: Option<String>) -> bool {
    resolve(&target, cwd.as_deref()).exists()
}

/// The file name travels percent-encoded, since headers only carry ASCII.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Saves a file dropped on a terminal and returns where it landed. The webview
/// only hands over the contents, never the original path.
#[tauri::command]
pub fn drop_save(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file contents".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v).replace(['/', '\\'], "_"))
        .filter(|v| !v.is_empty() && v != "." && v != "..")
        .unwrap_or_else(|| "arquivo".into());
    let dir = std::env::temp_dir()
        .join("shellhive-drops")
        .join(crate::hooks::next_public_id());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Writes text to a path the user picked in a save dialog.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("não consegui salvar {path}: {e}"))
}
