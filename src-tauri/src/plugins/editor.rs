//! Native side of the editor plugin (`plugins/editor`): the `open_editor`
//! tool shows a panel below the calling tab's terminal and waits for what the
//! user writes there.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::mcp::text_result;

/// How long a tool call waits for the user before returning control to Claude.
const EDIT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Inner {
    /// Request id -> submitted text, or None when the user cancelled.
    answers: HashMap<String, Option<String>>,
    waiting: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct Editors {
    inner: Arc<(Mutex<Inner>, Condvar)>,
}

impl Editors {
    fn register(&self, id: &str) {
        let (lock, _) = &*self.inner;
        lock.lock().unwrap().waiting.insert(id.to_string());
    }

    fn wait(&self, id: &str) -> Result<Option<String>, ()> {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        let deadline = Instant::now() + EDIT_TIMEOUT;
        loop {
            if let Some(answer) = guard.answers.remove(id) {
                guard.waiting.remove(id);
                return Ok(answer);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                guard.waiting.remove(id);
                return Err(());
            }
            let (next, _) = cv.wait_timeout(guard, remaining).unwrap();
            guard = next;
        }
    }

    /// Closes every open request, as if the user had closed each panel.
    fn cancel_all(&self) {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        let waiting: Vec<String> = guard.waiting.iter().cloned().collect();
        for id in waiting {
            guard.answers.insert(id, None);
        }
        cv.notify_all();
    }

    fn resolve(&self, id: &str, answer: Option<String>) -> bool {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        if !guard.waiting.contains(id) {
            return false;
        }
        guard.answers.insert(id.to_string(), answer);
        cv.notify_all();
        true
    }
}

#[derive(Clone, serde::Serialize)]
struct EditorRequest {
    id: String,
    tab_id: Option<String>,
    path: Option<String>,
    title: String,
    instructions: Option<String>,
    content: String,
    /// False when Claude is not waiting for a reply.
    blocking: bool,
    /// One of text, csv, json, xml.
    format: String,
}

#[tauri::command]
pub fn editor_submit(state: tauri::State<Editors>, id: String, content: String) -> bool {
    state.resolve(&id, Some(content))
}

#[tauri::command]
pub fn editor_cancel(state: tauri::State<Editors>, id: String) -> bool {
    state.resolve(&id, None)
}

/// The `open_editor` tool: shows the panel and, unless `wait` is false,
/// blocks until the user sends or closes it.
pub fn call(
    app: &AppHandle,
    tab_id: Option<String>,
    args: &serde_json::Value,
) -> serde_json::Value {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let given = args
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let blocking = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);

    let content = match (&path, &given) {
        (Some(p), None) => std::fs::read_to_string(p).unwrap_or_default(),
        (_, Some(c)) => c.clone(),
        (None, None) => String::new(),
    };
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            path.as_ref().and_then(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
        })
        .unwrap_or_else(|| "Editor".into());

    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let ext = path
                .as_ref()
                .and_then(|p| {
                    std::path::Path::new(p)
                        .extension()
                        .map(|e| e.to_string_lossy().to_lowercase())
                })
                .unwrap_or_default();
            match ext.as_str() {
                "csv" | "tsv" => "csv",
                "json" | "jsonc" => "json",
                "xml" | "svg" | "xhtml" | "plist" => "xml",
                _ => "text",
            }
            .to_string()
        });

    let id = format!("ed-{}", crate::hooks::next_public_id());
    let editors = app.state::<Editors>().inner().clone();
    if blocking {
        editors.register(&id);
    }
    let _ = app.emit(
        "editor-request",
        EditorRequest {
            id: id.clone(),
            tab_id,
            path: path.clone(),
            title,
            instructions: args
                .get("instructions")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            content,
            blocking,
            format,
        },
    );

    if !blocking {
        return text_result("Painel aberto para o usuário.".into(), false);
    }

    match editors.wait(&id) {
        Ok(Some(text)) => {
            if let Some(p) = &path {
                if let Some(parent) = std::path::Path::new(p).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(p, &text) {
                    return text_result(format!("Não consegui salvar {p}: {e}"), true);
                }
            }
            let saved = path.map(|p| format!(" e salvo em {p}")).unwrap_or_default();
            text_result(format!("O usuário terminou de editar{saved}.\n\n{text}"), false)
        }
        Ok(None) => text_result("O usuário fechou o editor sem enviar.".into(), true),
        Err(()) => text_result(
            "O usuário ainda não terminou de editar. Chame open_editor de novo com wait=true se quiser continuar aguardando."
                .into(),
            true,
        ),
    }
}

/// Called when the plugin is turned off, so no agent keeps waiting on a
/// panel that is no longer shown.
pub fn cancel_all(app: &AppHandle) {
    app.state::<Editors>().cancel_all();
}
