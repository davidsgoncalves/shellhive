use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};

/// Schema version, bumped whenever `migrate` gains a step.
const SCHEMA: i32 = 1;

pub struct Db(pub Mutex<Connection>);

fn db_path() -> Result<PathBuf, String> {
    let dir = crate::paths::data_dir().ok_or("no config dir")?;
    Ok(dir.join("data.db"))
}

pub fn open() -> Result<Db, String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    import_legacy_state(&conn);
    Ok(Db(Mutex::new(conn)))
}

/// Hook events kept, in milliseconds: a week.
const EVENTS_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Hook events are written on every tool call and only read to diagnose the
/// app, so they pile up. On launch, those older than a week are dropped and
/// the file is shrunk when any were. Runs on its own connection and thread so
/// the app does not wait on it.
pub fn prune_events_in_background() {
    std::thread::spawn(|| {
        if let Err(e) = prune_events() {
            eprintln!("[db] pruning events failed: {e}");
        }
    });
}

fn prune_events() -> Result<(), String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    let cutoff = now_millis() - EVENTS_KEEP_MS;
    let gone = conn
        .execute("DELETE FROM events WHERE received_at < ?1", params![cutoff])
        .map_err(|e| e.to_string())?;
    if gone > 0 {
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;
        eprintln!("[db] dropped {gone} hook events older than a week");
    }
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version >= SCHEMA {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_state (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            json       TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Every hook payload, stored raw so new features can reinterpret history.
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tab_id      TEXT,
            session_id  TEXT,
            hook_event  TEXT,
            payload     TEXT NOT NULL,
            received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_tab ON events (tab_id, received_at DESC);
        CREATE INDEX IF NOT EXISTS events_kind ON events (hook_event, received_at DESC);

        -- Permission requests and how long the human took to answer.
        CREATE TABLE IF NOT EXISTS permissions (
            id         TEXT PRIMARY KEY,
            tab_id     TEXT,
            session_id TEXT,
            tool_name  TEXT,
            summary    TEXT,
            raised_at  INTEGER NOT NULL,
            decided_at INTEGER,
            decision   TEXT
        );

        -- Transcript index; the transcripts themselves stay on disk.
        CREATE TABLE IF NOT EXISTS sessions (
            id           TEXT PRIMARY KEY,
            path         TEXT NOT NULL,
            project      TEXT,
            cwd          TEXT,
            custom_title TEXT,
            ai_title     TEXT,
            first_prompt TEXT,
            git_branch   TEXT,
            recap        TEXT,
            modified_at  INTEGER NOT NULL,
            size_bytes   INTEGER NOT NULL,
            indexed_size INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS sessions_recent ON sessions (modified_at DESC);

        -- Plain FTS table: rows are replaced by session_id when a transcript grows.
        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5 (
            session_id UNINDEXED,
            body
        );
        "#,
    )
    .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "user_version", SCHEMA)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves a layout saved by the previous file-based store into the database.
fn import_legacy_state(conn: &Connection) {
    let has: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_state", [], |r| r.get(0))
        .unwrap_or(0);
    if has > 0 {
        return;
    }
    let Some(dir) = crate::paths::data_dir() else {
        return;
    };
    let legacy = dir.join("state.json");
    let Ok(json) = std::fs::read_to_string(&legacy) else {
        return;
    };
    if json.trim().is_empty() {
        return;
    }
    if state_write(conn, &json).is_ok() {
        let _ = std::fs::rename(&legacy, dir.join("state.json.migrated"));
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn state_write(conn: &Connection, json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_state (id, json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![json, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn state_load(db: tauri::State<Db>) -> Result<Option<String>, String> {
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT json FROM app_state WHERE id = 1", [], |r| {
        r.get::<_, String>(0)
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

#[tauri::command]
pub fn state_save(db: tauri::State<Db>, contents: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    state_write(&conn, &contents)
}

/// Stores one hook payload. Failures are logged, never surfaced to Claude Code.
pub fn record_event(
    conn: &Connection,
    tab_id: Option<&str>,
    payload: &serde_json::Value,
    received_at: i64,
) {
    let session_id = payload.get("session_id").and_then(|v| v.as_str());
    let hook_event = payload.get("hook_event_name").and_then(|v| v.as_str());
    let text = serde_json::to_string(payload).unwrap_or_default();
    if let Err(e) = conn.execute(
        "INSERT INTO events (tab_id, session_id, hook_event, payload, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![tab_id, session_id, hook_event, text, received_at],
    ) {
        eprintln!("[db] event insert failed: {e}");
    }
}

pub fn record_permission_raised(
    conn: &Connection,
    id: &str,
    tab_id: Option<&str>,
    payload: &serde_json::Value,
    raised_at: i64,
) {
    let tool = payload.get("tool_name").and_then(|v| v.as_str());
    let summary = payload.get("tool_input").map(|v| v.to_string());
    let session_id = payload.get("session_id").and_then(|v| v.as_str());
    let _ = conn.execute(
        "INSERT OR REPLACE INTO permissions (id, tab_id, session_id, tool_name, summary, raised_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, tab_id, session_id, tool, summary, raised_at],
    );
}

pub fn record_permission_decided(conn: &Connection, id: &str, decision: Option<&str>) {
    let _ = conn.execute(
        "UPDATE permissions SET decided_at = ?2, decision = ?3 WHERE id = ?1",
        params![id, now_millis(), decision],
    );
}

#[derive(serde::Serialize)]
pub struct Metrics {
    pub permissions_total: i64,
    pub permissions_answered: i64,
    /// Median seconds between a request and its answer in the app.
    pub median_answer_seconds: Option<f64>,
    pub events_stored: i64,
    pub sessions_indexed: i64,
}

#[tauri::command]
pub fn metrics_summary(db: tauri::State<Db>) -> Result<Metrics, String> {
    let conn = db.0.lock().unwrap();
    let one = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
    let median: Option<f64> = conn
        .query_row(
            "SELECT AVG(d) FROM (
                 SELECT (decided_at - raised_at) / 1000.0 AS d
                 FROM permissions WHERE decided_at IS NOT NULL
                 ORDER BY d LIMIT 2 - (SELECT COUNT(*) FROM permissions WHERE decided_at IS NOT NULL) % 2
                 OFFSET (SELECT (COUNT(*) - 1) / 2 FROM permissions WHERE decided_at IS NOT NULL)
             )",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(Metrics {
        permissions_total: one("SELECT COUNT(*) FROM permissions"),
        permissions_answered: one("SELECT COUNT(*) FROM permissions WHERE decided_at IS NOT NULL"),
        median_answer_seconds: median,
        events_stored: one("SELECT COUNT(*) FROM events"),
        sessions_indexed: one("SELECT COUNT(*) FROM sessions"),
    })
}
