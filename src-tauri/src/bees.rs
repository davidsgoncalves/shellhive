//! Storage for the worker bees' runs. The bees themselves live in the app
//! state; their runs are kept apart so the history does not weigh on it.

use std::fs;
use std::path::PathBuf;

fn runs_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("bee-runs.json"))
}

/// The empty folder bees run in. From the home folder, Claude and the
/// prompt's commands would read Desktop, Documents and Downloads, and macOS
/// asks for each of them.
#[tauri::command]
pub fn bee_workdir() -> Result<String, String> {
    let dir = crate::paths::data_dir().ok_or("no data dir")?.join("worker-bee");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn bee_runs_get() -> serde_json::Value {
    runs_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn bee_runs_set(value: serde_json::Value) -> Result<(), String> {
    let path = runs_path().ok_or("no data dir")?;
    let body = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    // Written whole and swapped in, so a crash never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
