//! Codex and OpenCode sessions in the session index, next to Claude's. Codex
//! keeps one JSONL file per session under ~/.codex/sessions; OpenCode keeps
//! them in its SQLite database, read here without writing to it.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;

use crate::sessions::truncate;

/// Session bodies larger than this are indexed from their tail only.
const INDEX_MAX_BYTES: u64 = 12 * 1024 * 1024;
const PROMPT_MAX_CHARS: usize = 200;

/// One session as the index stores it.
struct Indexed<'a> {
    id: &'a str,
    provider: &'a str,
    path: &'a str,
    cwd: Option<&'a str>,
    title: Option<&'a str>,
    first_prompt: Option<&'a str>,
    modified_at: i64,
    size: i64,
    /// What tells a changed session from an unchanged one.
    marker: i64,
    body: &'a str,
}

fn known_marker(conn: &Connection, id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT indexed_size FROM sessions WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .ok()
}

fn store(conn: &Connection, s: &Indexed) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sessions (id, path, project, cwd, custom_title, first_prompt, modified_at,
                               size_bytes, indexed_size, provider)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
             path=excluded.path, project=excluded.project, cwd=excluded.cwd,
             custom_title=excluded.custom_title, first_prompt=excluded.first_prompt,
             modified_at=excluded.modified_at, size_bytes=excluded.size_bytes,
             indexed_size=excluded.indexed_size, provider=excluded.provider",
        params![
            s.id,
            s.path,
            s.cwd.unwrap_or(""),
            s.cwd,
            s.title,
            s.first_prompt,
            s.modified_at,
            s.size,
            s.marker,
            s.provider
        ],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM sessions_fts WHERE session_id = ?1",
        params![s.id],
    );
    let _ = conn.execute(
        "INSERT INTO sessions_fts (session_id, body) VALUES (?1, ?2)",
        params![s.id, s.body],
    );
    Ok(())
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => Some(dirs::home_dir()?.join(".codex")),
    }
}

/// Names given to Codex threads, latest last in the file.
fn codex_thread_names(home: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Ok(file) = File::open(home.join("session_index.jsonl")) else {
        return names;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            v.get("id").and_then(|i| i.as_str()),
            v.get("thread_name").and_then(|n| n.as_str()),
        ) {
            if !name.trim().is_empty() {
                names.insert(id.to_string(), name.to_string());
            }
        }
    }
    names
}

fn rollouts(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() && depth > 0 {
            rollouts(&path, out, depth - 1);
        } else if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// What the index needs from a Codex session file.
#[derive(Default, Debug, PartialEq)]
struct CodexSession {
    id: String,
    cwd: Option<String>,
    first_prompt: Option<String>,
    body: String,
    /// Opened by another session (a subagent), not by the user.
    spawned: bool,
}

fn read_codex(path: &Path, size: u64) -> Option<CodexSession> {
    let mut file = File::open(path).ok()?;
    let mut s = CodexSession::default();
    // The session's own record is the first line.
    let mut first = String::new();
    BufReader::new(&mut file).read_line(&mut first).ok()?;
    let meta: Value = serde_json::from_str(&first).ok()?;
    if meta.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = meta.get("payload")?;
    s.id = payload.get("id").and_then(|i| i.as_str())?.to_string();
    s.cwd = payload
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(str::to_string);
    s.spawned = payload.get("source").is_some_and(|src| src.is_object());
    let start = size.saturating_sub(INDEX_MAX_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        let text = p.get("message").and_then(|m| m.as_str()).unwrap_or("");
        match p.get("type").and_then(|t| t.as_str()) {
            // The text the user typed, without what Codex adds around it.
            Some("user_message") => {
                if s.first_prompt.is_none() && !text.trim().is_empty() {
                    s.first_prompt = Some(truncate(text, PROMPT_MAX_CHARS));
                }
            }
            Some("agent_message") => {}
            _ => continue,
        }
        s.body.push_str(text);
        s.body.push('\n');
    }
    Some(s)
}

/// Brings the index up to date with Codex's session files.
pub fn reindex_codex(conn: &Connection) -> Result<(), String> {
    let Some(home) = codex_home() else {
        return Ok(());
    };
    let mut files = Vec::new();
    rollouts(&home.join("sessions"), &mut files, 3);
    if files.is_empty() {
        return Ok(());
    }
    let names = codex_thread_names(&home);
    for path in files {
        let Ok(meta) = path.metadata() else { continue };
        let size = meta.len() as i64;
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // The id ends the file name; a known file of the same size is unchanged.
        let stem = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let guess = stem.get(stem.len().saturating_sub(36)..).unwrap_or("");
        if known_marker(conn, guess) == Some(size) {
            continue;
        }
        let Some(s) = read_codex(&path, meta.len()) else {
            continue;
        };
        if s.spawned || s.first_prompt.is_none() {
            continue;
        }
        let path_text = path.to_string_lossy();
        store(
            conn,
            &Indexed {
                id: &s.id,
                provider: "codex",
                path: &path_text,
                cwd: s.cwd.as_deref(),
                title: names.get(&s.id).map(String::as_str),
                first_prompt: s.first_prompt.as_deref(),
                modified_at: modified,
                size,
                marker: size,
                body: &s.body,
            },
        )?;
    }
    Ok(())
}

fn opencode_db() -> Option<PathBuf> {
    let data = match std::env::var_os("XDG_DATA_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => dirs::home_dir()?.join(".local").join("share"),
    };
    Some(data.join("opencode").join("opencode.db"))
}

/// Brings the index up to date with OpenCode's sessions.
pub fn reindex_opencode(conn: &Connection) -> Result<(), String> {
    let Some(path) = opencode_db().filter(|p| p.exists()) else {
        return Ok(());
    };
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let mut list = db
        .prepare(
            "SELECT id, directory, title, time_updated FROM session
             WHERE parent_id IS NULL AND time_archived IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let sessions: Vec<(String, String, String, i64)> = list
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    // Text parts in order, with the role of their message.
    let mut texts = db
        .prepare(
            "SELECT json_extract(m.data, '$.role'), json_extract(p.data, '$.text')
             FROM part p JOIN message m ON m.id = p.message_id
             WHERE p.session_id = ?1 AND json_extract(p.data, '$.type') = 'text'
               AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
             ORDER BY p.time_created, p.id",
        )
        .map_err(|e| e.to_string())?;
    let path_text = path.to_string_lossy();
    for (id, dir, title, updated) in sessions {
        if known_marker(conn, &id) == Some(updated) {
            continue;
        }
        let rows: Vec<(Option<String>, Option<String>)> = texts
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        let first_prompt = rows
            .iter()
            .find(|(role, t)| {
                role.as_deref() == Some("user")
                    && t.as_deref().is_some_and(|t| !t.trim().is_empty())
            })
            .and_then(|(_, t)| t.as_deref())
            .map(|t| truncate(t, PROMPT_MAX_CHARS));
        let Some(first_prompt) = first_prompt else {
            continue;
        };
        let body: String = rows
            .iter()
            .filter_map(|(_, t)| t.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        let body = if body.len() as u64 > INDEX_MAX_BYTES {
            let cut = body.len() - INDEX_MAX_BYTES as usize;
            let cut = (cut..body.len())
                .find(|i| body.is_char_boundary(*i))
                .unwrap_or(body.len());
            body[cut..].to_string()
        } else {
            body
        };
        store(
            conn,
            &Indexed {
                id: &id,
                provider: "opencode",
                path: &path_text,
                cwd: Some(&dir),
                title: Some(&title)
                    .filter(|t| !t.trim().is_empty())
                    .map(String::as_str),
                first_prompt: Some(&first_prompt),
                modified_at: updated / 1000,
                size: body.len() as i64,
                marker: updated,
                body: &body,
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_codex_session_keeps_what_the_user_typed_and_skips_subagents() {
        let dir = std::env::temp_dir().join(format!("shellhive-codex-idx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"01a1c6ed-0204-7e81-8024-efaca0a98596","cwd":"/p","source":"cli"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"corrige o teste"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Corrigido."}}"#,
        ];
        let path =
            dir.join("rollout-2026-11-10T16-26-23-01a1c6ed-0204-7e81-8024-efaca0a98596.jsonl");
        std::fs::write(&path, lines.join("\n")).unwrap();
        let s = read_codex(&path, 1000).unwrap();
        assert_eq!(s.id, "01a1c6ed-0204-7e81-8024-efaca0a98596");
        assert_eq!(
            (s.cwd.as_deref(), s.first_prompt.as_deref()),
            (Some("/p"), Some("corrige o teste"))
        );
        assert_eq!(s.body, "corrige o teste\nCorrigido.\n");
        assert!(!s.spawned);
        let sub = lines[0].replace(r#""source":"cli""#, r#""source":{"subagent":"review"}"#);
        std::fs::write(&path, sub).unwrap();
        assert!(read_codex(&path, 100).unwrap().spawned);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Indexes this machine's real Codex and OpenCode sessions into a
    /// throwaway database and prints only counts.
    #[test]
    #[ignore]
    fn indexes_the_real_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, path TEXT NOT NULL, project TEXT, cwd TEXT,
               custom_title TEXT, ai_title TEXT, first_prompt TEXT, git_branch TEXT, recap TEXT,
               modified_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, indexed_size INTEGER NOT NULL DEFAULT 0,
               provider TEXT);
             CREATE VIRTUAL TABLE sessions_fts USING fts5 (session_id UNINDEXED, body);",
        )
        .unwrap();
        reindex_codex(&conn).unwrap();
        reindex_opencode(&conn).unwrap();
        // A second pass finds nothing changed.
        reindex_codex(&conn).unwrap();
        reindex_opencode(&conn).unwrap();
        let mut q = conn
            .prepare("SELECT provider, count(*), sum(first_prompt IS NOT NULL), sum(custom_title IS NOT NULL), sum(cwd IS NOT NULL) FROM sessions GROUP BY provider")
            .unwrap();
        let rows: Vec<(String, i64, i64, i64, i64)> = q
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let fts: i64 = conn
            .query_row("SELECT count(*) FROM sessions_fts", [], |r| r.get(0))
            .unwrap();
        eprintln!(
            "provider, sessions, with prompt, with title, with cwd: {rows:?}; fts rows {fts}"
        );
    }
}
