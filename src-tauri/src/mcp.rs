use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// How long a tool call waits for the user before returning control to Claude.
const EDIT_TIMEOUT: Duration = Duration::from_secs(300);
const PROTOCOL_VERSION: &str = "2025-06-18";

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

fn text_result(text: String, is_error: bool) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "open_editor",
            "description": "Abre um editor em um painel dentro do Shellhive, logo abaixo do terminal, para o \
    usuário preencher, revisar ou colar algo, e devolve o conteúdo final. Use sempre que precisar que o usuário escreva \
    ou edite conteúdo, em vez de pedir para ele abrir um editor externo como VSCode. Suporta texto puro, CSV em planilha \
    editável, e JSON e XML com validação. Se `path` for informado, o arquivo é carregado e salvo com o que o usuário escrever.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Caminho do arquivo a abrir e salvar. Criado se não existir."
                    },
                    "content": {
                        "type": "string",
                        "description": "Conteúdo inicial ou template a pré-preencher. Ignorado se o arquivo já existir e content não for informado."
                    },
                    "title": { "type": "string", "description": "Título do painel." },
                    "instructions": {
                        "type": "string",
                        "description": "Instrução curta mostrada ao usuário sobre o que preencher."
                    },
                    "format": {
                        "type": "string",
                        "enum": ["text", "csv", "json", "xml"],
                        "description": "Editor a usar. Omitido, é deduzido da extensão do arquivo. csv abre uma planilha editável, json e xml abrem com validação e formatação."
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "Aguardar o usuário terminar e devolver o texto. Padrão true. Use false apenas para exibir algo."
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "suggest_command",
            "description": "Mostra ao usuário um comando de shell como um botão na fila do Shellhive. Ao clicar em \
    Executar, o comando roda nesta sessão como se o usuário tivesse digitado `! comando`, e a saída chega nesta conversa. \
    Use sempre que for pedir para o usuário rodar algo ele mesmo (login interativo, comando que exige a senha dele, \
    algo que você não deve rodar sozinho), em vez de escrever \"digite ! comando\". Não espera a execução.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Comando exato a executar, sem o ! na frente, numa linha só. Para vários passos, junte com && ou ponha num script." },
                    "reason": { "type": "string", "description": "Uma frase curta dizendo por que o usuário deve rodar isso." }
                },
                "required": ["command"],
                "additionalProperties": false
            }
        },
        {
            "name": "list_sessions",
            "description": "Lista as sessões do Claude Code gravadas nesta máquina, com título, pasta e data.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "Máximo de sessões. Padrão 20." }
                },
                "additionalProperties": false
            }
        }
    ])
}

fn call_open_editor(
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

#[derive(Clone, serde::Serialize)]
struct CommandSuggestion {
    id: String,
    tab_id: Option<String>,
    command: String,
    reason: Option<String>,
}

/// Shows a command as a button in the queue; nothing runs until the user clicks it.
fn call_suggest_command(
    app: &AppHandle,
    tab_id: Option<String>,
    args: &serde_json::Value,
) -> serde_json::Value {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .map(|c| c.trim().trim_start_matches('!').trim().to_string())
        .unwrap_or_default();
    if command.is_empty() {
        return text_result("Informe o comando em `command`.".into(), true);
    }
    // A line break reaches Claude's prompt as Enter and runs only the first line.
    if command.contains(['\n', '\r']) {
        return text_result(
            "O comando precisa caber numa linha só: junte os passos com && ou ponha num script e sugira só a chamada dele."
                .into(),
            true,
        );
    }
    if tab_id.is_none() {
        return text_result(
            "Esta sessão não está numa aba do Shellhive; peça ao usuário para rodar o comando."
                .into(),
            true,
        );
    }
    let _ = app.emit(
        "command-suggestion",
        CommandSuggestion {
            id: format!("cmd-{}", crate::hooks::next_public_id()),
            tab_id,
            command,
            reason: args
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        },
    );
    text_result(
        "O comando apareceu como botão na fila do Shellhive. Se o usuário executar, a saída chega nesta \
         conversa como uma mensagem dele. Não repita o comando no texto; diga só o que ele faz."
            .into(),
        false,
    )
}

fn call_list_sessions(app: &AppHandle, args: &serde_json::Value) -> serde_json::Value {
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
    let Some(db) = app.try_state::<crate::db::Db>() else {
        return text_result("Banco indisponível.".into(), true);
    };
    match crate::sessions::sessions_list(db) {
        Ok(list) => {
            let lines: Vec<String> = list
                .iter()
                .take(limit)
                .map(|s| {
                    let title = s
                        .titles
                        .custom
                        .clone()
                        .or_else(|| s.titles.ai.clone())
                        .or_else(|| s.first_prompt.clone())
                        .unwrap_or_else(|| s.id.clone());
                    format!(
                        "- {} | {} | {}",
                        title,
                        s.cwd.clone().unwrap_or_default(),
                        s.id
                    )
                })
                .collect();
            text_result(lines.join("\n"), false)
        }
        Err(e) => text_result(format!("Falhou: {e}"), true),
    }
}

/// Handles one JSON-RPC message. Returns None for notifications.
pub fn handle_rpc(
    app: &AppHandle,
    tab_id: Option<String>,
    msg: &serde_json::Value,
) -> Option<serde_json::Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    // A message with no id is a notification and gets no reply.
    let id = msg.get("id").cloned()?;

    let result = match method {
        "initialize" => serde_json::json!({
            "protocolVersion": msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "shellhive", "version": env!("CARGO_PKG_VERSION") }
        }),
        "ping" => serde_json::json!({}),
        "tools/list" => serde_json::json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or_default();
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            match name {
                "open_editor" => call_open_editor(app, tab_id, &args),
                "list_sessions" => call_list_sessions(app, &args),
                "suggest_command" => call_suggest_command(app, tab_id, &args),
                other => text_result(format!("Ferramenta desconhecida: {other}"), true),
            }
        }
        other => {
            return Some(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Método não suportado: {other}") }
            }));
        }
    };

    Some(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}
