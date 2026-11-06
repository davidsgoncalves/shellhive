//! Jira for the Bom dia plugin: the user's open issues and the ones they moved
//! on a past day. The API token stays on this side, in a file only the user
//! can read; the interface only ever sees the site and the e-mail.

use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};

#[derive(serde::Serialize, serde::Deserialize)]
struct Credentials {
    site: String,
    email: String,
    token: String,
}

#[derive(serde::Serialize)]
pub struct Account {
    pub site: String,
    pub email: String,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Issue {
    pub key: String,
    pub summary: String,
    pub status: String,
    /// Jira's status category: `new`, `indeterminate` or `done`.
    pub category: Option<String>,
    pub url: String,
}

#[derive(serde::Serialize)]
pub struct JiraDay {
    pub account: Account,
    /// Assigned to the user and not done.
    pub open: Vec<Issue>,
    /// Moved by the user on the day asked for.
    pub moved: Vec<Issue>,
}

fn file() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("welcome-jira.json"))
}

fn read() -> Option<Credentials> {
    serde_json::from_slice(&std::fs::read(file()?).ok()?).ok()
}

fn write(c: &Credentials) -> Result<(), String> {
    let path = file().ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        opts.mode(0o600);
        if path.exists() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
    }
    let mut f = opts.open(&path).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec(c).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// The host of a Jira Cloud site, from what the user typed: a full link, the
/// host or just the company name.
fn site(input: &str) -> Result<String, String> {
    let s = input.trim();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let host = s.split('/').next().unwrap_or("").to_ascii_lowercase();
    let valid = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !valid {
        return Err("Endereço do Jira inválido. Use algo como empresa.atlassian.net.".into());
    }
    Ok(if host.contains('.') {
        host
    } else {
        format!("{host}.atlassian.net")
    })
}

/// A value for curl's config syntax, which keeps the token out of the
/// command line where other processes could read it.
fn quoted(v: &str) -> String {
    let mut out = String::from("\"");
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn curl_config(c: &Credentials, path: &str, body: Option<&Value>) -> String {
    let mut config = format!(
        "url = {}\nuser = {}\nheader = \"Accept: application/json\"\nsilent\nshow-error\nmax-time = 20\nwrite-out = \"\\n%{{http_code}}\"\n",
        quoted(&format!("https://{}{}", c.site, path)),
        quoted(&format!("{}:{}", c.email, c.token)),
    );
    if let Some(body) = body {
        config.push_str("header = \"Content-Type: application/json\"\n");
        config.push_str(&format!("data-binary = {}\n", quoted(&body.to_string())));
    }
    config
}

/// One Jira REST call through curl, which ships with macOS, Windows 10 and
/// up, and the Linux desktops.
fn call(c: &Credentials, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let mut child = crate::connections::tool("curl")
        .args(["-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "curl não encontrado.".to_string())?;
    child
        .stdin
        .take()
        .ok_or("curl sem entrada")?
        .write_all(curl_config(c, path, body).as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Não consegui falar com o Jira.".into()
        } else {
            err
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (answer, code) = text.rsplit_once('\n').unwrap_or(("", &text));
    match code.trim() {
        "200" => serde_json::from_str(answer).map_err(|e| e.to_string()),
        "401" | "403" => {
            Err("O Jira recusou o e-mail ou o token. Confira os dois ou crie outro token.".into())
        }
        "404" => Err(format!("{} não é um site do Jira.", c.site)),
        code => Err(format!("O Jira respondeu {code}.")),
    }
}

fn issues(answer: &Value, site: &str) -> Vec<Issue> {
    answer["issues"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|i| {
                    let key = i["key"].as_str()?.to_string();
                    let f = &i["fields"];
                    Some(Issue {
                        summary: f["summary"].as_str().unwrap_or_default().into(),
                        status: f["status"]["name"].as_str().unwrap_or_default().into(),
                        category: f["status"]["statusCategory"]["key"]
                            .as_str()
                            .map(Into::into),
                        url: format!("https://{site}/browse/{key}"),
                        key,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn search(c: &Credentials, jql: &str) -> Result<Vec<Issue>, String> {
    let body = json!({ "jql": jql, "maxResults": 50, "fields": ["summary", "status"] });
    Ok(issues(
        &call(c, "/rest/api/3/search/jql", Some(&body))?,
        &c.site,
    ))
}

fn is_date(d: &str) -> bool {
    d.len() == 10 && d.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// Checks the e-mail and API token against the site and keeps them.
#[tauri::command]
pub async fn welcome_jira_connect(
    site: String,
    email: String,
    token: String,
) -> Result<Account, String> {
    let c = Credentials {
        site: self::site(&site)?,
        email: email.trim().to_string(),
        token: token.trim().to_string(),
    };
    if c.email.is_empty() || c.token.is_empty() {
        return Err("Preencha o e-mail e o token.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        call(&c, "/rest/api/3/myself", None)?;
        write(&c)?;
        Ok(Account {
            site: c.site,
            email: c.email,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forgets the saved token.
#[tauri::command]
pub fn welcome_jira_disconnect() -> Result<(), String> {
    match file() {
        Some(path) if path.exists() => std::fs::remove_file(path).map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

/// The user's open issues and the ones they moved between `day` and `next`
/// (YYYY-MM-DD), or None while Jira is not connected.
#[tauri::command]
pub async fn welcome_jira(day: String, next: String) -> Result<Option<JiraDay>, String> {
    if !is_date(&day) || !is_date(&next) {
        return Err("data inválida".into());
    }
    let Some(c) = read() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let moved_jql =
            format!("status CHANGED BY currentUser() DURING (\"{day}\", \"{next}\") ORDER BY updated DESC");
        let (open, moved) = std::thread::scope(|s| {
            let open = s.spawn(|| {
                search(
                    &c,
                    "assignee = currentUser() AND statusCategory != Done ORDER BY status ASC, updated DESC",
                )
            });
            let moved = s.spawn(|| search(&c, &moved_jql));
            (open.join(), moved.join())
        });
        let open = open.map_err(|_| "busca do Jira falhou".to_string())??;
        let moved = moved.map_err(|_| "busca do Jira falhou".to_string())??;
        Ok(Some(JiraDay {
            account: Account {
                site: c.site.clone(),
                email: c.email.clone(),
            },
            open,
            moved,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_site_from_a_link_a_host_or_a_name() {
        assert_eq!(
            site("https://acme.atlassian.net/jira/your-work").unwrap(),
            "acme.atlassian.net"
        );
        assert_eq!(site(" Acme.Atlassian.net ").unwrap(), "acme.atlassian.net");
        assert_eq!(site("acme").unwrap(), "acme.atlassian.net");
        assert!(site("").is_err());
        assert!(site("acme.net; rm -rf").is_err());
    }

    #[test]
    fn keeps_the_token_inside_a_quoted_curl_value() {
        let c = Credentials {
            site: "acme.atlassian.net".into(),
            email: "eu@acme.com".into(),
            token: "ab\"c\\d\nurl = \"https://evil\"".into(),
        };
        let config = curl_config(&c, "/rest/api/3/myself", None);
        let lines: Vec<_> = config.lines().collect();
        assert_eq!(
            lines[0],
            "url = \"https://acme.atlassian.net/rest/api/3/myself\""
        );
        assert_eq!(
            lines[1],
            r#"user = "eu@acme.com:ab\"c\\d\nurl = \"https://evil\"""#
        );
        assert!(!config.contains("data-binary"));
    }

    #[test]
    fn maps_the_issues_of_a_search() {
        let answer = json!({ "issues": [
            { "key": "VK-1", "fields": { "summary": "Tela nova", "status": { "name": "Code Review", "statusCategory": { "key": "indeterminate" } } } },
            { "fields": { "summary": "sem chave" } }
        ] });
        assert_eq!(
            issues(&answer, "acme.atlassian.net"),
            vec![Issue {
                key: "VK-1".into(),
                summary: "Tela nova".into(),
                status: "Code Review".into(),
                category: Some("indeterminate".into()),
                url: "https://acme.atlassian.net/browse/VK-1".into(),
            }]
        );
        assert!(issues(&json!({}), "acme.atlassian.net").is_empty());
    }
}
