//! Checks, without Claude, that the tools the app leans on are installed and
//! signed in: Claude Code, the GitHub CLI and Claude's MCP servers. Also reads
//! which GitHub repository a folder is a clone of.

use std::process::Command;
use std::sync::OnceLock;

/// The PATH of the user's interactive shell. An app opened from the Dock or
/// Finder gets a bare PATH that misses Homebrew and ~/.local/bin, where
/// `claude` and `gh` usually live.
fn shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(windows) {
            return None;
        }
        const MARK: &str = "__SHELLHIVE_PATH__";
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = crate::process::background(shell)
            .args(["-l", "-i", "-c", &format!("printf '{MARK}%s' \"$PATH\"")])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let path = text.rsplit(MARK).next()?.trim().to_string();
        (!path.is_empty()).then_some(path)
    })
    .as_deref()
}

pub(crate) fn tool(program: &str) -> Command {
    let mut cmd = crate::process::background(program);
    if let Some(path) = shell_path() {
        cmd.env("PATH", path);
    }
    cmd
}

/// Exit status and combined output, or None when the program is not installed.
fn run(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = tool(program).args(args).output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

#[derive(serde::Serialize)]
pub struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub ok: bool,
    pub detail: String,
    /// Command that fixes it, run in a new tab.
    pub fix: Option<String>,
}

fn check_claude() -> Check {
    let check = |ok, detail: &str, fix: Option<&str>| Check {
        id: "claude",
        label: "Claude Code",
        ok,
        detail: detail.to_string(),
        fix: fix.map(str::to_string),
    };
    let Some((_, out)) = run("claude", &["auth", "status"]) else {
        return check(
            false,
            "Não encontrado no PATH.",
            Some("curl -fsSL https://claude.ai/install.sh | bash"),
        );
    };
    let status: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or_default();
    if status["loggedIn"].as_bool() == Some(true) {
        let how = status["authMethod"].as_str().unwrap_or("conta");
        check(true, &format!("Logado ({how})."), None)
    } else {
        check(false, "Não está logado.", Some("claude auth login"))
    }
}

fn check_gh() -> Check {
    let check = |ok, detail: String, fix: Option<&str>| Check {
        id: "gh",
        label: "GitHub CLI (gh)",
        ok,
        detail,
        fix: fix.map(str::to_string),
    };
    let install = if cfg!(target_os = "macos") {
        "brew install gh"
    } else {
        "https://cli.github.com"
    };
    let Some((ok, out)) = run("gh", &["auth", "status"]) else {
        return check(false, "Não encontrado no PATH.".into(), Some(install));
    };
    if !ok {
        return check(false, "Não está logado.".into(), Some("gh auth login"));
    }
    let account = out
        .lines()
        .find_map(|l| l.split(" account ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or("");
    check(true, format!("Logado como {account}."), None)
}

/// Claude Code and the GitHub CLI, each installed and signed in.
#[tauri::command]
pub async fn connections_check() -> Vec<Check> {
    tauri::async_runtime::spawn_blocking(|| vec![check_claude(), check_gh()])
        .await
        .unwrap_or_default()
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct McpServer {
    pub name: String,
    /// "connected", "auth" (needs signing in) or "failed".
    pub status: &'static str,
}

fn parse_mcp_list(out: &str) -> Vec<McpServer> {
    out.lines()
        .filter_map(|line| {
            let (head, state) = line.rsplit_once(" - ")?;
            let name = head.split_once(": ")?.0.trim().to_string();
            let status = if state.contains("Connected") {
                "connected"
            } else if state.contains("authentication") {
                "auth"
            } else {
                "failed"
            };
            Some(McpServer { name, status })
        })
        .collect()
}

/// Claude's MCP servers and whether each connects. Takes a few seconds:
/// Claude Code connects to every one of them.
#[tauri::command]
pub async fn mcp_status() -> Result<Vec<McpServer>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (_, out) = run("claude", &["mcp", "list"]).ok_or("Claude Code não encontrado.")?;
        Ok(parse_mcp_list(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct Origin {
    /// `owner/name` on GitHub.
    pub slug: String,
    /// The main clone, even when `path` is one of its worktrees.
    pub root: String,
}

/// `owner/name` from a GitHub remote URL, over SSH or HTTPS.
fn github_slug(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("git@github.com:")
        .or_else(|| url.trim().split_once("github.com/").map(|(_, r)| r))?;
    let slug = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = slug.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty() && parts.next().is_none())
        .then(|| format!("{owner}/{name}"))
}

/// The GitHub repository a folder is a clone of, if its `origin` is on GitHub.
#[tauri::command]
pub async fn git_origin(path: String) -> Option<Origin> {
    origin_of(path)
}

/// The repositories in a folder: the folder itself when it is a clone,
/// otherwise the clones right inside it.
#[tauri::command]
pub async fn git_origins_in(path: String) -> Vec<Origin> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(origin) = origin_of(path.clone()) {
            return vec![origin];
        }
        let Ok(entries) = std::fs::read_dir(&path) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| origin_of(e.path().to_string_lossy().into_owned()))
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn origin_of(path: String) -> Option<Origin> {
    let git = |args: &[&str]| -> Option<String> {
        let out = tool("git").arg("-C").arg(&path).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let slug = github_slug(&git(&["remote", "get-url", "origin"])?)?;
    // Worktrees share the main clone's .git, which sits right inside it.
    let common = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let root = match common.strip_suffix("/.git") {
        Some(main) => main.to_string(),
        None => git(&["rev-parse", "--show-toplevel"]).unwrap_or(path.clone()),
    };
    Some(Origin { slug, root })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_github_remotes() {
        assert_eq!(
            github_slug("git@github.com:acme/api.git").as_deref(),
            Some("acme/api")
        );
        assert_eq!(
            github_slug("https://github.com/acme/web").as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            github_slug("https://github.com/acme/web.git/").as_deref(),
            Some("acme/web")
        );
        assert_eq!(github_slug("git@gitlab.com:acme/api.git"), None);
    }

    #[test]
    fn reads_mcp_list() {
        let out = "Checking MCP server health…\n\n\
                   claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected\n\
                   plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\n\
                   local: npx thing - ✗ Failed to connect\n";
        let servers = parse_mcp_list(out);
        assert_eq!(
            servers,
            vec![
                McpServer {
                    name: "claude.ai Slack".into(),
                    status: "connected"
                },
                McpServer {
                    name: "plugin:figma:figma".into(),
                    status: "auth"
                },
                McpServer {
                    name: "local".into(),
                    status: "failed"
                },
            ]
        );
    }
}
