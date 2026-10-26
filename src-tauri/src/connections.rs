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

fn tool(program: &str) -> Command {
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

#[cfg(test)]
mod tests {
    use super::*;

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
