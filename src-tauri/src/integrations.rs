//! Services flows watch: GitHub, Jira and Slack, read with the user's own
//! tokens. Tokens live in the system's credential store and never reach the
//! interface; the interface asks for GET requests to the service's API only.

use std::sync::Mutex;
use std::time::Duration;

const SERVICE: &str = "shellhive";
const TIMEOUT: Duration = Duration::from_secs(20);
const SERVICES: [&str; 3] = ["github", "jira", "slack"];

fn entry(service: &str) -> Result<keyring::Entry, String> {
    if !SERVICES.contains(&service) {
        return Err(format!("serviço desconhecido: {service}"));
    }
    keyring::Entry::new(SERVICE, &format!("integration-{service}")).map_err(|e| e.to_string())
}

fn stored(service: &str) -> Option<String> {
    entry(service)
        .ok()?
        .get_password()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

/// GitHub falls back to the token of a logged-in `gh`.
fn github_token() -> Option<String> {
    stored("github").or_else(|| {
        let out = crate::process::background("gh")
            .args(["auth", "token"])
            .output()
            .ok()?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !token.is_empty()).then_some(token)
    })
}

#[tauri::command]
pub fn integration_secret_set(service: String, value: String) -> Result<(), String> {
    let e = entry(&service)?;
    if value.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(value.trim()).map_err(|e| e.to_string())
}

/// Which services have a token, and where GitHub's comes from.
#[tauri::command]
pub async fn integration_secret_status() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| {
        let github = if stored("github").is_some() {
            "stored"
        } else if github_token().is_some() {
            "gh"
        } else {
            "none"
        };
        serde_json::json!({
            "github": github,
            "jira": stored("jira").is_some(),
            "slack": stored("slack").is_some(),
        })
    })
    .await
    .unwrap_or_default()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into()
}

/// The base URL and Authorization header for a service.
fn target(
    service: &str,
    jira_site: Option<&str>,
    jira_email: Option<&str>,
) -> Result<(String, String), String> {
    use base64::Engine;
    match service {
        "github" => {
            let token = github_token()
                .ok_or("Sem token do GitHub. Configure em Configurações › Integrações.")?;
            Ok(("https://api.github.com".into(), format!("Bearer {token}")))
        }
        "jira" => {
            let token = stored("jira")
                .ok_or("Sem token do Jira. Configure em Configurações › Integrações.")?;
            let site = jira_site
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Informe o site do Jira.")?;
            let email = jira_email
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Informe o e-mail do Jira.")?;
            let host = site
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/');
            // Only an Atlassian Cloud site gets the token.
            if host.contains('/') || !host.ends_with(".atlassian.net") {
                return Err("O site do Jira deve ser algo como empresa.atlassian.net.".into());
            }
            let basic =
                base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}"));
            Ok((format!("https://{host}"), format!("Basic {basic}")))
        }
        "slack" => {
            let token = stored("slack")
                .ok_or("Sem token do Slack. Configure em Configurações › Integrações.")?;
            Ok(("https://slack.com/api".into(), format!("Bearer {token}")))
        }
        other => Err(format!("serviço desconhecido: {other}")),
    }
}

/// A GET to a service's API, as the user. `path` starts with "/" and may carry a query.
#[tauri::command]
pub async fn integration_get(
    service: String,
    path: String,
    jira_site: Option<String>,
    jira_email: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !path.starts_with('/') || path.contains("://") || path.contains("..") {
            return Err("caminho inválido".to_string());
        }
        let (base, auth) = target(&service, jira_site.as_deref(), jira_email.as_deref())?;
        let resp = agent()
            .get(format!("{base}{path}"))
            .header("Authorization", &auth)
            .header("Accept", "application/json")
            .header("User-Agent", "Shellhive")
            .call()
            .map_err(|e| format!("{service}: {e}"))?;
        let status = resp.status().as_u16();
        let body = resp
            .into_body()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value =
            serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body));
        if status >= 400 {
            let msg = json
                .get("message")
                .or_else(|| json.get("errorMessages").and_then(|m| m.get(0)))
                .and_then(|m| m.as_str())
                .unwrap_or("erro")
                .to_string();
            return Err(format!("{service} respondeu {status}: {msg}"));
        }
        // Slack answers 200 with ok:false.
        if service == "slack" && json.get("ok") == Some(&serde_json::Value::Bool(false)) {
            let err = json.get("error").and_then(|e| e.as_str()).unwrap_or("erro");
            return Err(format!("slack: {err}"));
        }
        Ok(json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Held while scheduled flows want the machine awake.
static AWAKE: Mutex<Option<keepawake::KeepAwake>> = Mutex::new(None);

#[tauri::command]
pub fn keep_awake(on: bool) -> Result<(), String> {
    let mut held = AWAKE.lock().map_err(|e| e.to_string())?;
    if !on {
        *held = None;
        return Ok(());
    }
    if held.is_none() {
        let guard = keepawake::Builder::default()
            .display(false)
            .idle(true)
            .sleep(true)
            .reason("Fluxos agendados do Shellhive")
            .app_name("Shellhive")
            .app_reverse_domain("com.shellhive.app")
            .create()
            .map_err(|e| e.to_string())?;
        *held = Some(guard);
    }
    Ok(())
}

/// The port flows' webhooks listen on.
#[tauri::command]
pub fn webhook_port() -> u16 {
    crate::hooks::PORT
}
