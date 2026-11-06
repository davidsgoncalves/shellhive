//! Backend of the Bom dia plugin: what the user did on a past day, read from
//! the git repositories they work in, the GitHub CLI and the app's own log of
//! Claude sessions. The weather and the page itself live in the interface.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::params;

use crate::db::Db;

/// Folders whose children are scanned for repositories stop at this many
/// entries, so a home folder handed in by mistake stays cheap.
const SCAN_LIMIT: usize = 200;
/// Repositories read per day, at most.
const REPO_LIMIT: usize = 80;

#[derive(serde::Serialize)]
pub struct Commit {
    pub sha: String,
    /// Milliseconds since the epoch.
    pub at: i64,
    pub subject: String,
}

#[derive(serde::Serialize)]
pub struct RepoCommits {
    pub name: String,
    pub path: String,
    pub commits: Vec<Commit>,
}

#[derive(serde::Serialize)]
pub struct DaySession {
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    /// Messages the user sent that day; zero when only the transcript says it changed.
    pub prompts: i64,
    /// Milliseconds since the epoch of the first message that day.
    pub first: i64,
}

#[derive(serde::Serialize)]
pub struct DayWork {
    pub repos: Vec<RepoCommits>,
    pub sessions: Vec<DaySession>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::connections::tool("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repository holding `dir`, or, when it is a plain folder of projects,
/// the repositories right inside it.
fn repos_in(dir: &Path) -> Vec<PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }
    if let Some(top) = git(dir, &["rev-parse", "--show-toplevel"]) {
        return vec![PathBuf::from(top.trim())];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(SCAN_LIMIT)
        .map(|e| e.path())
        .filter(|p| p.join(".git").exists())
        .collect()
}

/// The user's own commits in a repository between two instants, one per
/// subject, so a rebased branch does not count twice. The author is the
/// repository's `user.email`, which falls back to the global one.
fn commits_in(repo: &Path, start_ms: i64, end_ms: i64) -> Vec<Commit> {
    let Some(email) = git(repo, &["config", "user.email"]).map(|e| e.trim().to_string()) else {
        return Vec::new();
    };
    if email.is_empty() {
        return Vec::new();
    }
    let author = format!("--author={email}");
    let since = format!("--since=@{}", start_ms / 1000);
    let until = format!("--until=@{}", (end_ms - 1) / 1000);
    let Some(log) = git(
        repo,
        &[
            "log",
            "--all",
            "--no-merges",
            &author,
            &since,
            &until,
            "--format=%h%x09%at%x09%s",
        ],
    ) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut commits: Vec<Commit> = log
        .lines()
        .filter_map(|line| {
            let mut cols = line.splitn(3, '\t');
            let sha = cols.next()?.to_string();
            let at = cols.next()?.parse::<i64>().ok()? * 1000;
            let subject = cols.next()?.to_string();
            seen.insert(subject.clone())
                .then_some(Commit { sha, at, subject })
        })
        .collect();
    commits.sort_by_key(|c| c.at);
    commits
}

/// Claude sessions the user talked to between two instants: from the hook log,
/// which keeps a week, plus any whose transcript last changed in that window.
fn sessions_between(db: &Db, start_ms: i64, end_ms: i64) -> Result<Vec<DaySession>, String> {
    let conn = db.0.lock().unwrap();
    let title = |custom: Option<String>, ai: Option<String>, prompt: Option<String>| {
        custom
            .or(ai)
            .or_else(|| prompt.map(|p| p.chars().take(80).collect()))
            .unwrap_or_else(|| "Sessão sem título".into())
    };
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.custom_title, s.ai_title, s.first_prompt, s.cwd, COUNT(e.id), MIN(e.received_at)
             FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE e.hook_event = 'UserPromptSubmit' AND e.received_at >= ?1 AND e.received_at < ?2
             GROUP BY s.id ORDER BY MIN(e.received_at)",
        )
        .map_err(|e| e.to_string())?;
    let mut sessions = stmt
        .query_map(params![start_ms, end_ms], |r| {
            Ok(DaySession {
                id: r.get(0)?,
                title: title(r.get(1)?, r.get(2)?, r.get(3)?),
                cwd: r.get(4)?,
                prompts: r.get(5)?,
                first: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let known: HashSet<String> = sessions.iter().map(|s| s.id.clone()).collect();
    let mut stmt = conn
        .prepare(
            "SELECT id, custom_title, ai_title, first_prompt, cwd, modified_at FROM sessions
             WHERE modified_at >= ?1 AND modified_at < ?2 ORDER BY modified_at",
        )
        .map_err(|e| e.to_string())?;
    let touched = stmt
        .query_map(params![start_ms / 1000, end_ms / 1000], |r| {
            Ok(DaySession {
                id: r.get(0)?,
                title: title(r.get(1)?, r.get(2)?, r.get(3)?),
                cwd: r.get(4)?,
                prompts: 0,
                first: r.get::<_, i64>(5)? * 1000,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    sessions.extend(touched.into_iter().filter(|s| !known.contains(&s.id)));
    sessions.sort_by_key(|s| s.first);
    Ok(sessions)
}

/// Commits and Claude sessions between two instants. Repositories are looked
/// for in `folders` (the registered folders and open tabs) and in the folders
/// of that day's sessions.
#[tauri::command]
pub async fn welcome_day(
    db: tauri::State<'_, Db>,
    start_ms: i64,
    end_ms: i64,
    folders: Vec<String>,
) -> Result<DayWork, String> {
    let sessions = sessions_between(&db, start_ms, end_ms)?;
    let mut dirs: Vec<String> = folders;
    dirs.extend(sessions.iter().filter_map(|s| s.cwd.clone()));

    let repos = tauri::async_runtime::spawn_blocking(move || {
        let found: BTreeSet<PathBuf> = std::thread::scope(|s| {
            let handles: Vec<_> = dirs
                .iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(|d| s.spawn(move || repos_in(Path::new(d))))
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        std::thread::scope(|s| {
            let handles: Vec<_> = found
                .iter()
                .take(REPO_LIMIT)
                .map(|repo| s.spawn(move || (repo, commits_in(repo, start_ms, end_ms))))
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .filter(|(_, commits)| !commits.is_empty())
                .map(|(repo, commits)| RepoCommits {
                    name: repo
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    path: repo.to_string_lossy().into_owned(),
                    commits,
                })
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(DayWork { repos, sessions })
}

const PR_FIELDS: &str = "number title url isDraft createdAt mergedAt repository { nameWithOwner name } author { login } reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

/// The user's pull requests through the GitHub CLI: opened, merged and
/// reviewed on `day` (YYYY-MM-DD), plus the open ones and the reviews asked of
/// them. Returns GitHub's answer as is; the interface picks what it shows.
#[tauri::command]
pub async fn welcome_github(day: String) -> Result<serde_json::Value, String> {
    if !day.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("data inválida".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let query = format!(
            "query($opened: String!, $merged: String!, $reviewed: String!, $mine: String!, $asked: String!) {{
              viewer {{ login }}
              opened: search(query: $opened, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }}
              merged: search(query: $merged, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }}
              reviewed: search(query: $reviewed, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS}
                reviews(last: 30) {{ nodes {{ state submittedAt author {{ login }} }} }} }} }} }}
              mine: search(query: $mine, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }}
              asked: search(query: $asked, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }}
            }}"
        );
        let out = crate::connections::tool("gh")
            .args(["api", "graphql"])
            .args(["-f", &format!("query={query}")])
            .args(["-f", &format!("opened=is:pr author:@me created:{day}")])
            .args(["-f", &format!("merged=is:pr author:@me merged:{day}")])
            .args(["-f", &format!("reviewed=is:pr reviewed-by:@me -author:@me updated:>={day}")])
            .args(["-f", "mine=is:pr is:open author:@me archived:false sort:updated-desc"])
            .args(["-f", "asked=is:pr is:open review-requested:@me archived:false sort:created-asc"])
            .output()
            .map_err(|_| "GitHub CLI (gh) não encontrado.".to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { "gh falhou".into() } else { err });
        }
        let mut answer: serde_json::Value =
            serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(answer["data"].take())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shellhive-welcome-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(dir: &Path, email: &str) {
        std::fs::create_dir_all(dir).unwrap();
        sh(dir, &["init", "-q"]);
        sh(dir, &["config", "user.email", email]);
        sh(dir, &["config", "user.name", "Teste"]);
    }

    fn commit(dir: &Path, subject: &str, at: i64) {
        let date = format!("@{at} +0000");
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["commit", "-q", "--allow-empty", "-m", subject])
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok);
    }

    #[test]
    fn finds_the_repo_of_a_folder_or_the_repos_inside_it() {
        let base = scratch("find");
        repo(&base.join("api"), "a@b.c");
        repo(&base.join("web"), "a@b.c");
        std::fs::create_dir_all(base.join("notes")).unwrap();

        let mut inside = repos_in(&base);
        inside.sort();
        assert_eq!(inside, vec![base.join("api"), base.join("web")]);

        let deep = base.join("api").join("src");
        std::fs::create_dir_all(&deep).unwrap();
        let top = repos_in(&deep);
        assert_eq!(top.len(), 1);
        assert!(top[0].ends_with("api"));
    }

    #[test]
    fn keeps_only_the_users_commits_of_the_day() {
        let base = scratch("log");
        let dir = base.join("api");
        repo(&dir, "eu@x.com");
        let day = 1_790_000_000;
        commit(&dir, "before", day - 10);
        commit(&dir, "first", day + 100);
        commit(&dir, "second", day + 200);
        commit(&dir, "after", day + 86_400 + 10);
        sh(&dir, &["config", "user.email", "outra@x.com"]);
        commit(&dir, "someone else", day + 300);
        sh(&dir, &["config", "user.email", "eu@x.com"]);

        let got = commits_in(&dir, day * 1000, (day + 86_400) * 1000);
        let subjects: Vec<_> = got.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["first", "second"]);
        assert_eq!(got[0].at, (day + 100) * 1000);
    }
}
