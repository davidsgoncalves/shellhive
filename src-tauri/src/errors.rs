//! Error reports. Every install keeps a local log of its errors, which the
//! "Relatar problema" button attaches to a GitHub issue. When the user turns
//! reports on and the build carries a DSN, the same errors go to Sentry.
//! Either way, text is scrubbed first: the home folder, the user name and
//! anything shaped like a token never leave the machine.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Set at build time from the CI secret; absent in local builds.
const DSN: Option<&str> = option_env!("SHELLHIVE_SENTRY_DSN");
const LOG_MAX_BYTES: u64 = 512 * 1024;

static CLIENT: Mutex<Option<sentry::ClientInitGuard>> = Mutex::new(None);
static RELEASE: Mutex<Option<String>> = Mutex::new(None);

fn dir() -> Option<PathBuf> {
    crate::paths::data_dir()
}

fn log_path() -> Option<PathBuf> {
    Some(dir()?.join("errors.log"))
}

fn consent_path() -> Option<PathBuf> {
    Some(dir()?.join("error-reports.json"))
}

fn consented() -> bool {
    consent_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("enabled").and_then(|e| e.as_bool()))
        .unwrap_or(false)
}

/// True for a word that looks like a credential: a known token prefix, or a
/// long run mixing letters and digits.
fn looks_secret(word: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "ghp_",
        "gho_",
        "ghs_",
        "github_pat_",
        "xox",
        "AKIA",
        "ASIA",
        "eyJ",
        "AIza",
    ];
    if PREFIXES.iter().any(|p| word.starts_with(p)) && word.len() >= 12 {
        return true;
    }
    let letters = word.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let digits = word.chars().filter(|c| c.is_ascii_digit()).count();
    word.len() >= 32 && letters > 0 && digits > 0
}

/// Removes what could identify the user or leak a secret.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy().to_string();
        if !home.is_empty() {
            out = out.replace(&home, "~");
        }
    }
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME"));
    if let Some(user) = user.ok().filter(|u| u.len() > 2) {
        out = out.replace(&user, "<usuario>");
    }
    let mut masked = String::with_capacity(out.len());
    let mut word = String::new();
    let flush = |word: &mut String, masked: &mut String| {
        if looks_secret(word) {
            masked.push_str("<oculto>");
        } else {
            masked.push_str(word);
        }
        word.clear();
    };
    for c in out.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '=') {
            word.push(c);
        } else {
            flush(&mut word, &mut masked);
            masked.push(c);
        }
    }
    flush(&mut word, &mut masked);
    masked
}

fn append_log(line: &str) {
    let Some(path) = log_path() else { return };
    // Keep the log small: start over once it grows past the cap.
    if fs::metadata(&path)
        .map(|m| m.len() > LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Records an error from anywhere in the app: always to the local log, and
/// to Sentry when reports are on.
pub fn record(source: &str, message: &str) {
    let message = scrub(message);
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    append_log(&format!("{secs} [{source}] {}", message.replace('\n', " ")));
    if CLIENT.lock().map(|c| c.is_some()).unwrap_or(false) {
        sentry::with_scope(
            |scope| scope.set_tag("source", source),
            || sentry::capture_message(&message, sentry::Level::Error),
        );
    }
}

fn start_client() {
    let Some(dsn) = DSN.filter(|d| !d.is_empty()) else {
        return;
    };
    let release = RELEASE.lock().ok().and_then(|r| r.clone());
    let guard = sentry::init((dsn, {
        // ClientOptions is non-exhaustive, so it is filled field by field.
        let mut options = sentry::ClientOptions::default();
        options.release = release.map(|v| format!("shellhive@{v}").into());
        options.send_default_pii = false;
        // Scrub what the SDK gathered on its own, as record() does for messages.
        options.before_send = Some(std::sync::Arc::new(|mut event| {
            event.server_name = None;
            event.user = None;
            event.message = event.message.map(|m| scrub(&m));
            for exception in event.exception.values.iter_mut() {
                exception.value = exception.value.as_deref().map(scrub);
            }
            for crumb in event.breadcrumbs.values.iter_mut() {
                crumb.message = crumb.message.as_deref().map(scrub);
            }
            Some(event)
        }));
        options
    }));
    if let Ok(mut client) = CLIENT.lock() {
        *client = Some(guard);
    }
}

fn stop_client() {
    if let Ok(mut client) = CLIENT.lock() {
        // Dropping the guard flushes and closes the client.
        *client = None;
    }
}

/// Called once at startup: panics go to the local log, and Sentry starts if
/// the user already agreed.
pub fn init(app_version: String) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if let Ok(mut release) = RELEASE.lock() {
        *release = Some(app_version);
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record("panic", &info.to_string());
        previous(info);
    }));
    if consented() {
        start_client();
    }
}

#[derive(serde::Serialize)]
pub struct ReportsState {
    enabled: bool,
    /// False in builds without a DSN, where reports have nowhere to go.
    available: bool,
}

#[tauri::command]
pub fn error_reports_get() -> ReportsState {
    ReportsState {
        enabled: consented(),
        available: DSN.is_some_and(|d| !d.is_empty()),
    }
}

#[tauri::command]
pub fn error_reports_set(enabled: bool) -> Result<(), String> {
    let path = consent_path().ok_or("no config dir")?;
    fs::write(path, serde_json::json!({ "enabled": enabled }).to_string())
        .map_err(|e| e.to_string())?;
    if enabled {
        start_client();
    } else {
        stop_client();
    }
    Ok(())
}

/// True when reports are on and the build can send them.
pub fn sending() -> bool {
    CLIENT.lock().map(|c| c.is_some()).unwrap_or(false)
}

/// Sends a performance diagnostic the user asked for, already scrubbed, and
/// waits for it to leave. Returns the Sentry event id, which the user can
/// pass on to find it.
pub fn send_diagnostic(report: serde_json::Value) -> String {
    let mut event = sentry::protocol::Event {
        message: Some("Diagnóstico de desempenho".into()),
        level: sentry::Level::Info,
        ..Default::default()
    };
    event.tags.insert("source".into(), "diagnostic".into());
    if let serde_json::Value::Object(map) = report {
        for (k, v) in map {
            event.extra.insert(k, v);
        }
    }
    let id = sentry::capture_event(event);
    if let Some(client) = sentry::Hub::current().client() {
        client.flush(Some(std::time::Duration::from_secs(5)));
    }
    id.to_string()
}

/// Errors caught by the interface.
#[tauri::command]
pub fn report_error(source: String, message: String) {
    record(&source, &message);
}

/// The newest lines of the local log, already scrubbed, for an issue.
#[tauri::command]
pub fn error_log_tail(lines: usize) -> String {
    let Some(text) = log_path().and_then(|p| fs::read_to_string(p).ok()) else {
        return String::new();
    };
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn hides_home_folder() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert_eq!(
            scrub(&format!("falhou em {home}/projeto/x.rs")),
            "falhou em ~/projeto/x.rs"
        );
    }

    #[test]
    fn hides_tokens() {
        let text = "token ghp_abcdefghijklmnop1234 e sk-ant-api03-XYZ123456789 ok";
        let out = scrub(text);
        assert!(!out.contains("ghp_"), "{out}");
        assert!(!out.contains("sk-ant"), "{out}");
        assert!(out.contains("ok"));
    }

    #[test]
    fn hides_long_mixed_strings() {
        let out = scrub("chave a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7 fim");
        assert_eq!(out, "chave <oculto> fim");
    }

    #[test]
    fn keeps_ordinary_text() {
        let text = "pty_spawn failed: No such file or directory (os error 2)";
        assert_eq!(scrub(text), text);
    }
}
