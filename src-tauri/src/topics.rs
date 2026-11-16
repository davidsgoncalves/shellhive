//! Topics: what a subject that outlasts one chat has taught, kept in a folder
//! of the app's data. The folder belongs to the agent: a session that has the
//! topic attached is told where it is and that it now keeps it, reads what it
//! needs from it and writes what is worth keeping. The user only creates
//! topics and attaches them to tabs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// A topic as the interface keeps it.
#[derive(serde::Deserialize, Clone, PartialEq, Debug)]
pub struct TopicRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Titles of the other tabs the topic is attached to, which keep it too.
    #[serde(default)]
    pub others: Vec<String>,
}

/// The topics attached to each tab, as the interface keeps them.
static ATTACHED: Mutex<Option<HashMap<String, Vec<TopicRef>>>> = Mutex::new(None);
/// The topics each tab's session was told about since it started.
static TOLD: Mutex<Option<HashMap<String, Vec<TopicRef>>>> = Mutex::new(None);

/// The file each topic starts with and the agent keeps current.
const SUMMARY: &str = "RESUMO.md";
/// Most of the summary told to a session; the rest stays in the file.
const SUMMARY_MAX: usize = 6000;
/// Most files of a topic listed to a session.
const FILES_MAX: usize = 80;

pub fn root() -> Option<PathBuf> {
    let dir = crate::paths::data_dir()?.join("topics");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn dir_of(id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| root().map(|r| r.join(id)))?
}

/// A folder name from a topic's name: lowercase ASCII words joined by dashes.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(fold).collect::<String>().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "topico".into()
    } else {
        out
    }
}

/// Strips the accents Portuguese names carry, so the folder name stays ASCII.
fn fold(c: char) -> Vec<char> {
    let plain = match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'A',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'É' | 'È' | 'Ê' | 'Ë' => 'E',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'Í' | 'Ì' | 'Î' | 'Ï' => 'I',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'O',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'Ú' | 'Ù' | 'Û' | 'Ü' => 'U',
        'ç' => 'c',
        'Ç' => 'C',
        'ñ' => 'n',
        'Ñ' => 'N',
        other => other,
    };
    vec![plain]
}

/// Creates a topic's folder with its first summary and returns its id.
#[tauri::command]
pub fn topic_create(name: String, description: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Dê um nome ao tópico.".into());
    }
    let root = root().ok_or("sem pasta de dados")?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let id = format!("{}-{:04x}", slug(name), (nanos >> 10) as u16);
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let about = description.trim();
    let first = format!(
        "# {name}\n\n{}Nada registrado ainda.\n",
        if about.is_empty() {
            String::new()
        } else {
            format!("{about}\n\n")
        }
    );
    std::fs::write(dir.join(SUMMARY), first).map_err(|e| e.to_string())?;
    Ok(id)
}

/// The topics attached to each tab, sent by the interface whenever they change.
#[tauri::command]
pub fn topic_tabs(tabs: HashMap<String, Vec<TopicRef>>) {
    *ATTACHED.lock().unwrap() = Some(tabs);
}

fn attached(tab: &str) -> Vec<TopicRef> {
    ATTACHED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(tab).cloned())
        .unwrap_or_default()
}

/// Files of a topic, by path inside its folder, newest first.
fn files(dir: &Path) -> Vec<(String, u64, SystemTime)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(dir) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)));
            }
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.2));
    out
}

fn size_label(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

/// What a session is told about one topic: where it is, its summary and its files.
fn topic_block(t: &TopicRef) -> String {
    let Some(dir) = dir_of(&t.id) else {
        return String::new();
    };
    let summary = std::fs::read_to_string(dir.join(SUMMARY)).unwrap_or_default();
    let summary = if summary.chars().count() > SUMMARY_MAX {
        let cut: String = summary.chars().take(SUMMARY_MAX).collect();
        format!("{cut}\n[… o resto está no arquivo]")
    } else {
        summary
    };
    let list = files(&dir);
    let mut lines: Vec<String> = list
        .iter()
        .take(FILES_MAX)
        .map(|(rel, len, _)| format!("- {rel} ({})", size_label(*len)))
        .collect();
    if list.len() > FILES_MAX {
        lines.push(format!("- … e mais {} arquivos", list.len() - FILES_MAX));
    }
    let mut about = if t.description.trim().is_empty() {
        String::new()
    } else {
        format!("Do que se trata: {}\n", t.description.trim())
    };
    if !t.others.is_empty() {
        about.push_str(&format!(
            "Outras conversas também cuidam deste tópico ({}): releia RESUMO.md e o arquivo antes de mudar, \
             e não apague o que outra conversa salvou sem motivo.\n",
            t.others.join(", ")
        ));
    }
    format!(
        "## Tópico \"{}\"\n{about}Pasta: {}\nArquivos:\n{}\n\n{SUMMARY} atual:\n<<<\n{}\n>>>",
        t.name,
        dir.display(),
        if lines.is_empty() {
            "- (nenhum)".to_string()
        } else {
            lines.join("\n")
        },
        summary.trim()
    )
}

/// How a session keeps the topics it is given.
const DUTY: &str = "Os tópicos são a memória de longo prazo de um assunto que dura mais que uma conversa. \
A partir de agora esta conversa é a responsável por eles: a pasta de cada um é sua, \
só você (a IA) lê e escreve nela, e o usuário não mexe nesses arquivos.\n\
- Consulte os arquivos quando o assunto pedir. Não leia tudo de antemão.\n\
- Ao longo do trabalho, salve o que for importante e durável: decisões e o porquê, causas encontradas, \
comandos, caminhos e configurações que funcionaram, o que foi tentado e falhou, pendências e próximos passos. \
Não salve a conversa em si nem o que dá para descobrir de novo lendo o código.\n\
- Organize como achar melhor, com um arquivo por assunto e nomes claros. Consolide, corrija e apague o que ficou velho ou errado.\n\
- Mantenha RESUMO.md como o estado atual em poucas linhas: onde o assunto está, o que vale saber primeiro \
e um índice dos outros arquivos. É o que a próxima conversa lê primeiro.\n\
- Escreva com as ferramentas de arquivo (Write e Edit), que podem escrever nessas pastas sem pedir permissão. \
Salve sem pedir confirmação e sem avisar a cada vez.";

fn told_text(topics: &[TopicRef]) -> String {
    let blocks: Vec<String> = topics.iter().map(topic_block).collect();
    format!(
        "# Tópicos do Shellhive ligados a esta conversa\n\n{DUTY}\n\n{}",
        blocks.join("\n\n")
    )
}

fn set_told(tab: &str, topics: Vec<TopicRef>) {
    TOLD.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(tab.to_string(), topics);
}

/// What a session starting (or resuming, or compacted) in `tab` is told about its topics.
pub fn session_start_context(tab: Option<&str>) -> Option<String> {
    let tab = tab.filter(|t| !t.is_empty())?;
    let topics = attached(tab);
    set_told(tab, topics.clone());
    (!topics.is_empty()).then(|| told_text(&topics))
}

/// What goes with the next prompt in `tab`: topics attached or detached since
/// its session was last told, or None when nothing changed.
pub fn prompt_context(tab: Option<&str>) -> Option<String> {
    let tab = tab.filter(|t| !t.is_empty())?;
    let now = attached(tab);
    let before = TOLD
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(tab).cloned())
        .unwrap_or_default();
    let added: Vec<TopicRef> = now
        .iter()
        .filter(|t| !before.iter().any(|b| b.id == t.id))
        .cloned()
        .collect();
    let removed: Vec<&TopicRef> = before
        .iter()
        .filter(|b| !now.iter().any(|t| t.id == b.id))
        .collect();
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(told_text(&added));
    }
    for t in &removed {
        parts.push(format!(
            "O tópico \"{}\" foi desligado desta conversa: não leia nem escreva mais na pasta dele.",
            t.name
        ));
    }
    set_told(tab, now);
    Some(parts.join("\n\n"))
}

/// What the terminal shows for `:topico`: the topic being attached, or the
/// ones already attached when no name is given. The interface does the work.
pub fn command_reply(tab: Option<&str>, args: &str) -> String {
    let name = args.trim();
    if !name.is_empty() {
        return format!("Shellhive: tópico \"{name}\" ligado a esta conversa. Ele chega ao Claude com a próxima mensagem.");
    }
    let names: Vec<String> = tab
        .map(attached)
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.name)
        .collect();
    if names.is_empty() {
        "Shellhive: nenhum tópico ligado. Use :topico Nome para ligar ou criar um.".into()
    } else {
        format!("Shellhive: tópicos ligados: {}.", names.join(", "))
    }
}

/// A path as Claude Code's permission rules write an absolute one: `//` then
/// the path, with a Windows drive as `/c`.
fn rule_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        format!("//{}{}", s[..1].to_ascii_lowercase(), &s[2..])
    } else {
        format!("/{s}")
    }
}

/// Permission rules that let every session read and write the topics' folders
/// without asking, and the folder to add to its working directories.
pub fn permissions() -> Option<(Vec<String>, String)> {
    let root = root()?;
    let rule = rule_path(&root);
    let rules = vec![format!("Read({rule}/**)"), format!("Edit({rule}/**)")];
    Some((rules, root.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_ascii_words() {
        assert_eq!(slug("Bug do Login — produção"), "bug-do-login-producao");
        assert_eq!(slug("   "), "topico");
        assert_eq!(slug("Ação!!"), "acao");
    }

    #[test]
    fn rule_paths_are_absolute() {
        assert_eq!(
            rule_path(Path::new(
                "C:\\Users\\x\\AppData\\Roaming\\shellhive\\topics"
            )),
            "//c/Users/x/AppData/Roaming/shellhive/topics"
        );
        assert_eq!(
            rule_path(Path::new("/home/x/.config/shellhive/topics")),
            "//home/x/.config/shellhive/topics"
        );
    }

    #[test]
    fn a_prompt_tells_only_what_changed() {
        let tab = "test-tab-topics";
        let t = TopicRef {
            id: "test-topic-0000".into(),
            name: "Teste".into(),
            description: String::new(),
            others: vec![],
        };
        ATTACHED
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(tab.into(), vec![]);
        assert!(session_start_context(Some(tab)).is_none());
        assert!(prompt_context(Some(tab)).is_none());
        ATTACHED
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .insert(tab.into(), vec![t.clone()]);
        let told = prompt_context(Some(tab)).unwrap();
        assert!(told.contains("Tópico \"Teste\""));
        assert!(prompt_context(Some(tab)).is_none());
        ATTACHED
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .insert(tab.into(), vec![]);
        assert!(prompt_context(Some(tab)).unwrap().contains("foi desligado"));
        assert!(prompt_context(Some(tab)).is_none());
    }
}
