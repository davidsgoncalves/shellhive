use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

const PROTOCOL_VERSION: &str = "2025-06-18";

pub(crate) fn text_result(text: String, is_error: bool) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

/// Tabs opened to create worker bees with Claude; only they see the bee tools.
static BEE_CREATORS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Hidden tabs running a bee; only they see the tools of a run.
static BEE_RUNS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Tabs of a colony's drones, Queens included; they see the colony tools.
static DRONES: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Tabs of a colony's Queen; only they build the colony.
static QUEENS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn listed(set: &Mutex<Option<HashSet<String>>>, tab_id: Option<&str>) -> bool {
    tab_id.is_some_and(|id| {
        set.lock()
            .unwrap()
            .as_ref()
            .is_some_and(|tabs| tabs.contains(id))
    })
}

fn is_bee_creator(tab_id: Option<&str>) -> bool {
    listed(&BEE_CREATORS, tab_id)
}

fn is_bee_run(tab_id: Option<&str>) -> bool {
    listed(&BEE_RUNS, tab_id)
}

fn is_drone(tab_id: Option<&str>) -> bool {
    listed(&DRONES, tab_id)
}

fn is_queen(tab_id: Option<&str>) -> bool {
    listed(&QUEENS, tab_id)
}

/// The tabs of the colonies' drones and of their Queens, as the interface keeps them.
#[tauri::command]
pub fn colony_tabs(drones: Vec<String>, queens: Vec<String>) {
    *DRONES.lock().unwrap() = Some(drones.into_iter().collect());
    *QUEENS.lock().unwrap() = Some(queens.into_iter().collect());
}

/// The tabs that create bees, as the interface keeps them.
#[tauri::command]
pub fn bee_creator_tabs(ids: Vec<String>) {
    *BEE_CREATORS.lock().unwrap() = Some(ids.into_iter().collect());
}

/// The tabs running a bee, as the interface keeps them.
#[tauri::command]
pub fn bee_run_tabs(ids: Vec<String>) {
    *BEE_RUNS.lock().unwrap() = Some(ids.into_iter().collect());
}

/// Tools of the core, followed by those of the enabled plugins, and the bee
/// tools for a tab that creates bees.
fn tool_definitions(tab_id: Option<&str>) -> serde_json::Value {
    let mut tools = core_tools();
    tools.extend(crate::plugins::tools());
    if is_bee_creator(tab_id) {
        tools.extend(bee_tools());
    }
    if is_bee_run(tab_id) {
        tools.extend(bee_run_tools());
    }
    if is_drone(tab_id) {
        tools.extend(drone_tools());
    }
    if is_queen(tab_id) {
        tools.extend(queen_tools());
    }
    serde_json::Value::Array(tools)
}

const BEE_TOOLS: [&str; 3] = ["create_bee", "list_bees", "run_bee"];

fn bee_tools() -> Vec<serde_json::Value> {
    let tools = serde_json::json!([
        {
            "name": "list_bees",
            "description": "Lista as worker bees (id, nome, se está ligada, quando roda) e os templates prontos, com o prompt de cada um.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "create_bee",
            "description": "Cria uma worker bee, desligada até o usuário conferir no painel e ligar. Só chame depois de o usuário confirmar o resumo e o prompt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Nome curto da worker bee." },
                    "prompt": { "type": "string", "description": "O prompt completo que a worker bee roda, sem nenhum {{...}} sobrando." },
                    "template": { "type": "string", "description": "Id do template usado de base, se houver." },
                    "trigger": {
                        "type": "object",
                        "description": "Quando roda: {\"kind\":\"manual\"}, {\"kind\":\"interval\",\"minutes\":60} ou {\"kind\":\"schedule\",\"days\":[1,2,3,4,5],\"time\":\"09:00\"} (0 = domingo).",
                        "properties": {
                            "kind": { "type": "string", "enum": ["manual", "interval", "schedule"] },
                            "minutes": { "type": "number" },
                            "days": { "type": "array", "items": { "type": "number" } },
                            "time": { "type": "string" }
                        },
                        "required": ["kind"]
                    },
                    "missed": { "type": "string", "enum": ["run", "skip"], "description": "Horário perdido com o app fechado: run roda uma vez ao abrir (padrão), skip pula." },
                    "worktree": { "type": "boolean", "description": "Uma execução que recebe um repositório trabalha numa worktree nova dele." },
                    "permissionMode": { "type": "string", "enum": ["manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"], "description": "Modo de permissão do Claude nas execuções. Sem ele, vale o do app." },
                    "allowedTools": { "type": "array", "items": { "type": "string" }, "description": "Regras liberadas sem perguntar, como no Claude Code: \"Bash(gh pr:*)\", \"Edit\"." }
                },
                "required": ["name", "prompt", "trigger"],
                "additionalProperties": false
            }
        },
        {
            "name": "run_bee",
            "description": "Roda agora uma worker bee, pelo id de list_bees.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "cwd": { "type": "string", "description": "Pasta em que esta execução trabalha. Sem ela, roda na pasta vazia das worker bees." }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }
    ]);
    tools.as_array().cloned().unwrap_or_default()
}

const BEE_RUN_TOOLS: [&str; 3] = ["bee_state_get", "bee_state_set", "bee_needs_you"];

fn bee_run_tools() -> Vec<serde_json::Value> {
    let tools = serde_json::json!([
        {
            "name": "bee_state_get",
            "description": "Lê o que esta worker bee guardou com bee_state_set numa execução anterior. Devolve null se nada foi guardado.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "bee_state_set",
            "description": "Guarda um valor JSON que a próxima execução desta worker bee lê com bee_state_get. Substitui o anterior inteiro. Até 16 mil caracteres.",
            "inputSchema": {
                "type": "object",
                "properties": { "state": { "description": "Qualquer valor JSON: objeto, lista, texto ou número." } },
                "required": ["state"],
                "additionalProperties": false
            }
        },
        {
            "name": "bee_needs_you",
            "description": "Avisa o usuário que esta execução precisa dele, com o motivo. Use quando não der para seguir sem uma decisão ou ação dele.",
            "inputSchema": {
                "type": "object",
                "properties": { "reason": { "type": "string", "description": "O que o usuário precisa decidir ou fazer, numa ou duas frases." } },
                "required": ["reason"],
                "additionalProperties": false
            }
        }
    ]);
    tools.as_array().cloned().unwrap_or_default()
}

const DRONE_TOOLS: [&str; 2] = ["colony_members", "send_message"];
const QUEEN_TOOLS: [&str; 3] = ["create_drone", "update_drone", "remove_drone"];

fn drone_tools() -> Vec<serde_json::Value> {
    let tools = serde_json::json!([
        {
            "name": "colony_members",
            "description": "Lista os membros desta colony: nome, função, descrição, agente, modelo e se está ocupado.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "send_message",
            "description": "Manda um pedido a outro membro da colony. A mensagem espera na fila dele até ele ficar livre. A resposta final do turno dele chega para você como mensagem nova: termine o seu turno em vez de esperar.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Nome do membro, como em colony_members." },
                    "text": { "type": "string", "description": "O pedido, completo o bastante para ser feito sem perguntas." },
                    "expectsReply": { "type": "boolean", "description": "false quando não precisa de resposta. Padrão true." }
                },
                "required": ["to", "text"],
                "additionalProperties": false
            }
        }
    ]);
    tools.as_array().cloned().unwrap_or_default()
}

fn drone_properties() -> serde_json::Value {
    serde_json::json!({
        "name": { "type": "string", "description": "Nome do drone, único na colony." },
        "role": { "type": "string", "description": "A função, em poucas palavras. Os colegas escolhem por ela." },
        "description": { "type": "string", "description": "O que o drone sabe fazer e quando pedir a ele." },
        "instructions": { "type": "string", "description": "Como o drone trabalha. Vai no começo da sessão dele." },
        "agent": { "type": "string", "enum": ["claude", "codex", "opencode"], "description": "O agente que roda o drone. Padrão claude." },
        "model": { "type": "string", "description": "Modelo do agente, como claude-sonnet-5-5. Sem ele, vale o padrão do agente." },
        "permissionMode": { "type": "string", "enum": ["manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"], "description": "Modo de permissão do Claude. Sem ele, vale o do app." },
        "allowedTools": { "type": "array", "items": { "type": "string" }, "description": "Regras do Claude liberadas sem perguntar, como \"Bash(gh pr:*)\"." }
    })
}

fn queen_tools() -> Vec<serde_json::Value> {
    let props = drone_properties();
    let tools = serde_json::json!([
        {
            "name": "create_drone",
            "description": "Cria um drone nesta colony. Só chame depois de o usuário confirmar a proposta.",
            "inputSchema": { "type": "object", "properties": props, "required": ["name", "role"], "additionalProperties": false }
        },
        {
            "name": "update_drone",
            "description": "Muda os campos dados de um drone, pelo nome. Trocar agente ou modelo reabre a sessão dele.",
            "inputSchema": { "type": "object", "properties": props, "required": ["name"], "additionalProperties": false }
        },
        {
            "name": "remove_drone",
            "description": "Remove um drone, pelo nome. Só chame depois de o usuário confirmar.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"],
                "additionalProperties": false
            }
        }
    ]);
    tools.as_array().cloned().unwrap_or_default()
}

fn core_tools() -> Vec<serde_json::Value> {
    let tools = serde_json::json!([
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
    ]);
    tools.as_array().cloned().unwrap_or_default()
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
        "tools/list" => serde_json::json!({ "tools": tool_definitions(tab_id.as_deref()) }),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or_default();
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            match name {
                "list_sessions" => call_list_sessions(app, &args),
                "suggest_command" => call_suggest_command(app, tab_id, &args),
                bee if BEE_TOOLS.contains(&bee) && is_bee_creator(tab_id.as_deref()) => {
                    crate::plugins::call_frontend(app, "worker-bee", bee, tab_id, &args)
                }
                bee if BEE_RUN_TOOLS.contains(&bee) && is_bee_run(tab_id.as_deref()) => {
                    crate::plugins::call_frontend(app, "worker-bee", bee, tab_id, &args)
                }
                tool if DRONE_TOOLS.contains(&tool) && is_drone(tab_id.as_deref()) => {
                    crate::plugins::call_frontend(app, "colony", tool, tab_id, &args)
                }
                tool if QUEEN_TOOLS.contains(&tool) && is_queen(tab_id.as_deref()) => {
                    crate::plugins::call_frontend(app, "colony", tool, tab_id, &args)
                }
                other => match crate::plugins::tool_owner(other).as_deref() {
                    Some("editor") => crate::plugins::editor::call(app, tab_id, &args),
                    Some(plugin) if crate::plugins::local::is_local(plugin) => {
                        crate::plugins::local::call(app, plugin, other, tab_id, &args)
                    }
                    Some(plugin) => {
                        crate::plugins::call_frontend(app, plugin, other, tab_id, &args)
                    }
                    None => text_result(format!("Ferramenta desconhecida: {other}"), true),
                },
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
