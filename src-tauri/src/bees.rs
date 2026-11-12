//! Storage for the worker bees' runs. The bees themselves live in the app
//! state; their runs are kept apart so the history does not weigh on it.

use std::fs;
use std::path::PathBuf;

fn runs_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("bee-runs.json"))
}

/// The empty folder bees run in. From the home folder, Claude and the
/// prompt's commands would read Desktop, Documents and Downloads, and macOS
/// asks for each of them.
#[tauri::command]
pub fn bee_workdir() -> Result<String, String> {
    let dir = crate::paths::data_dir()
        .ok_or("no data dir")?
        .join("worker-bee");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir = dir.to_string_lossy().into_owned();
    // No one answers Claude's trust dialog on a bee run, so the folder is
    // trusted ahead. A failure only means the dialog may show up.
    let _ = trust_folder(&dir);
    Ok(dir)
}

/// The folder a bee runs in when it has one. With `worktree`, `dir` must be a
/// git repository: each run gets a fresh worktree of it, detached at the
/// remote's default branch (or HEAD), in place of the bee's last one. The last
/// one is kept until then, so its session can still be opened.
#[tauri::command]
pub async fn bee_prepare_dir(
    bee_id: String,
    dir: String,
    worktree: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !std::path::Path::new(&dir).is_dir() {
            return Err(format!("a pasta {dir} não existe"));
        }
        let path = if worktree {
            let root = crate::paths::data_dir()
                .ok_or("no data dir")?
                .join("worker-bee")
                .join("worktrees");
            fresh_worktree(&root, &bee_id, &dir)?
        } else {
            dir
        };
        let _ = trust_folder(&path);
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::process::background("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn fresh_worktree(root: &std::path::Path, bee_id: &str, repo: &str) -> Result<String, String> {
    if bee_id.is_empty()
        || !bee_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("id de worker bee inválido".into());
    }
    git(repo, &["rev-parse", "--git-dir"])
        .map_err(|_| format!("{repo} não é um repositório git"))?;
    let path = root.join(bee_id);
    let path_str = path.to_string_lossy().into_owned();
    if path.exists() {
        // A worktree of another repository, or one git lost track of, goes by hand.
        if git(repo, &["worktree", "remove", "--force", &path_str]).is_err() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        }
    }
    let _ = git(repo, &["worktree", "prune"]);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let base = if git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/HEAD",
        ],
    )
    .is_ok()
    {
        "origin/HEAD"
    } else {
        "HEAD"
    };
    git(repo, &["worktree", "add", "--detach", &path_str, base])?;
    Ok(path_str)
}

/// Longest output a bee command shows in its card.
const COMMAND_OUTPUT_MAX: usize = 2000;

/// Runs a command a bee suggested, after its tab closed: in the user's login
/// shell, so tools like `gh` are on the PATH. Returns the output; an exit
/// other than zero comes back as the error.
#[tauri::command]
pub async fn bee_command_run(command: String, cwd: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = if cfg!(windows) {
            let mut c = crate::process::background("powershell.exe");
            c.args(["-NoLogo", "-NoProfile", "-Command", &command]);
            c
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut c = crate::process::background(shell);
            c.args(["-l", "-c", &command]);
            c
        };
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.current_dir(dir);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !err.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&err);
        }
        if text.len() > COMMAND_OUTPUT_MAX {
            let cut = (0..=COMMAND_OUTPUT_MAX)
                .rev()
                .find(|&i| text.is_char_boundary(i))
                .unwrap_or(0);
            text.truncate(cut);
            text.push('…');
        }
        if out.status.success() {
            Ok(text)
        } else {
            Err(if text.is_empty() {
                format!("saiu com {}", out.status)
            } else {
                text
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude's global config, where it keeps the folders it trusts.
fn claude_config_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => Some(PathBuf::from(dir).join(".claude.json")),
        None => Some(dirs::home_dir()?.join(".claude.json")),
    }
}

/// Marks `dir` as trusted in Claude's config, unless it already is.
fn trust_folder(dir: &str) -> Result<(), String> {
    let path = claude_config_path().ok_or("no home dir")?;
    // Claude writes Windows paths with forward slashes.
    let key = if cfg!(windows) {
        dir.replace('\\', "/")
    } else {
        dir.to_string()
    };
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut config: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !mark_trusted(&mut config, &key) {
        return Ok(());
    }
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.shellhive-tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Sets the trust flag on the project `key`; false when nothing changed.
fn mark_trusted(config: &mut serde_json::Value, key: &str) -> bool {
    let Some(root) = config.as_object_mut() else {
        return false;
    };
    let projects = root
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}));
    let Some(projects) = projects.as_object_mut() else {
        return false;
    };
    let project = projects.entry(key).or_insert_with(|| serde_json::json!({}));
    let Some(project) = project.as_object_mut() else {
        return false;
    };
    if project.get("hasTrustDialogAccepted") == Some(&serde_json::Value::Bool(true)) {
        return false;
    }
    project.insert("hasTrustDialogAccepted".into(), true.into());
    true
}

#[cfg(test)]
mod tests {
    use super::{fresh_worktree, git, mark_trusted};
    use serde_json::json;

    #[test]
    fn each_run_gets_a_clean_worktree_of_the_repo() {
        let tmp = std::env::temp_dir().join(format!("shellhive-wt-{}", std::process::id()));
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let r = repo.to_str().unwrap();
        git(r, &["init", "-q"]).unwrap();
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git(r, &["add", "."]).unwrap();
        git(
            r,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "one",
            ],
        )
        .unwrap();

        let root = tmp.join("worktrees");
        let first = fresh_worktree(&root, "bee-1", r).unwrap();
        std::fs::write(
            std::path::Path::new(&first).join("scratch.txt"),
            "left over",
        )
        .unwrap();
        let second = fresh_worktree(&root, "bee-1", r).unwrap();
        assert_eq!(first, second);
        assert!(std::path::Path::new(&second).join("a.txt").exists());
        assert!(!std::path::Path::new(&second).join("scratch.txt").exists());
        // The user's copy is untouched, and git tracks a single bee worktree.
        assert!(!repo.join("scratch.txt").exists());
        let list = git(r, &["worktree", "list"]).unwrap();
        assert_eq!(list.lines().count(), 2);

        assert!(fresh_worktree(&root, "../x", r).is_err());
        assert!(fresh_worktree(&root, "bee-2", tmp.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn trusts_a_new_folder_and_keeps_the_rest() {
        let mut config = json!({ "theme": "dark", "projects": { "/a": { "x": 1 } } });
        assert!(mark_trusted(&mut config, "/b"));
        assert_eq!(
            config["projects"]["/b"]["hasTrustDialogAccepted"],
            json!(true)
        );
        assert_eq!(config["projects"]["/a"], json!({ "x": 1 }));
        assert_eq!(config["theme"], json!("dark"));
    }

    #[test]
    fn leaves_a_trusted_folder_alone() {
        let mut config =
            json!({ "projects": { "/b": { "hasTrustDialogAccepted": true, "y": 2 } } });
        assert!(!mark_trusted(&mut config, "/b"));
        assert_eq!(config["projects"]["/b"]["y"], json!(2));
    }
}

#[tauri::command]
pub fn bee_runs_get() -> serde_json::Value {
    runs_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn bee_runs_set(value: serde_json::Value) -> Result<(), String> {
    let path = runs_path().ok_or("no data dir")?;
    let body = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    // Written whole and swapped in, so a crash never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
