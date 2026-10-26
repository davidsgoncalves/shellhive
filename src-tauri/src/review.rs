//! GitHub side of the review bee, through the `gh` CLI: the pull requests
//! waiting on the user's review, publishing what Claude found, and the
//! user's own verdict. Claude never publishes; it only writes its findings.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::connections::tool;

fn gh(args: &[&str]) -> Result<String, String> {
    let out = tool("gh")
        .args(args)
        .output()
        .map_err(|e| format!("gh: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn my_login() -> Result<&'static str, String> {
    static LOGIN: OnceLock<String> = OnceLock::new();
    if let Some(login) = LOGIN.get() {
        return Ok(login);
    }
    let login = gh(&["api", "user", "--jq", ".login"])?;
    Ok(LOGIN.get_or_init(|| login))
}

#[derive(serde::Serialize)]
pub struct Candidate {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub branch: String,
    pub head: String,
    /// Commit of the user's last review still standing, if any.
    pub reviewed_head: Option<String>,
    /// When the user's review was last requested, as GitHub writes it.
    pub requested_at: Option<String>,
}

fn candidate(repo: &str, number: u64, url: String, title: String) -> Result<Candidate, String> {
    let n = number.to_string();
    let view: serde_json::Value = serde_json::from_str(&gh(&[
        "pr",
        "view",
        &n,
        "-R",
        repo,
        "--json",
        "headRefOid,headRefName",
    ])?)
    .map_err(|e| e.to_string())?;
    let me = my_login()?;
    let reviewed_head = gh(&[
        "api",
        "--paginate",
        &format!("repos/{repo}/pulls/{n}/reviews"),
        "--jq",
        &format!(r#".[] | select(.user.login == "{me}" and .state != "DISMISSED") | .commit_id"#),
    ])?
    .lines()
    .last()
    .map(str::to_string);
    let (owner, name) = repo.split_once('/').ok_or("repositório inválido")?;
    let requested_at = gh(&[
        "api",
        "graphql",
        "-f",
        "query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){timelineItems(last:50,itemTypes:[REVIEW_REQUESTED_EVENT]){nodes{... on ReviewRequestedEvent{createdAt requestedReviewer{... on User{login}}}}}}}}",
        "-F",
        &format!("o={owner}"),
        "-F",
        &format!("r={name}"),
        "-F",
        &format!("n={n}"),
        "--jq",
        &format!(
            r#".data.repository.pullRequest.timelineItems.nodes[] | select(.requestedReviewer.login == "{me}") | .createdAt"#
        ),
    ])
    .ok()
    .and_then(|out| out.lines().last().map(str::to_string));
    Ok(Candidate {
        repo: repo.to_string(),
        number,
        url,
        title,
        branch: view["headRefName"].as_str().unwrap_or_default().to_string(),
        head: view["headRefOid"].as_str().unwrap_or_default().to_string(),
        reviewed_head,
        requested_at,
    })
}

/// Open pull requests, not drafts, that ask for the user's review in these repositories.
#[tauri::command]
pub async fn review_candidates(repos: Vec<String>) -> Result<Vec<Candidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let found: Vec<serde_json::Value> = serde_json::from_str(&gh(&[
            "search",
            "prs",
            "--review-requested=@me",
            "--state=open",
            "--json",
            "number,title,url,isDraft,repository",
            "--limit",
            "100",
        ])?)
        .map_err(|e| e.to_string())?;
        found
            .iter()
            .filter(|pr| pr["isDraft"].as_bool() != Some(true))
            .filter_map(|pr| {
                let repo = pr["repository"]["nameWithOwner"].as_str()?;
                repos.iter().any(|r| r.eq_ignore_ascii_case(repo)).then(|| {
                    candidate(
                        repo,
                        pr["number"].as_u64().unwrap_or_default(),
                        pr["url"].as_str().unwrap_or_default().to_string(),
                        pr["title"].as_str().unwrap_or_default().to_string(),
                    )
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

fn findings_path(run_id: &str) -> Option<PathBuf> {
    let safe = run_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-');
    safe.then(|| {
        crate::paths::data_dir().map(|d| d.join("bee-reviews").join(format!("{run_id}.json")))
    })?
}

/// Where a review run writes its findings; the folder is made on the way.
#[tauri::command]
pub fn review_findings_path(run_id: String) -> Result<String, String> {
    let path = findings_path(&run_id).ok_or("no data dir")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[derive(serde::Deserialize)]
struct Finding {
    /// "bloqueante", "dúvida" or "sugestão".
    weight: String,
    path: Option<String>,
    line: Option<u64>,
    /// The comment as published, prefix included.
    body: String,
}

#[derive(serde::Deserialize)]
struct PrFindings {
    repo: String,
    number: u64,
    #[serde(default)]
    findings: Vec<Finding>,
}

#[derive(serde::Deserialize)]
struct FindingsFile {
    #[serde(default)]
    prs: Vec<PrFindings>,
}

#[derive(serde::Serialize)]
pub struct Published {
    pub repo: String,
    pub number: u64,
    /// "REQUEST_CHANGES", "COMMENT", or "clean" when nothing was found.
    pub verdict: String,
    pub comments: usize,
    pub error: Option<String>,
}

fn publish_pr(pr: &PrFindings) -> Result<Published, String> {
    let (repo, n) = (pr.repo.as_str(), pr.number.to_string());
    let done = |verdict: &str, comments| Published {
        repo: repo.to_string(),
        number: pr.number,
        verdict: verdict.to_string(),
        comments,
        error: None,
    };
    if pr.findings.is_empty() {
        return Ok(done("clean", 0));
    }
    let head = gh(&[
        "pr",
        "view",
        &n,
        "-R",
        repo,
        "--json",
        "headRefOid",
        "--jq",
        ".headRefOid",
    ])?;
    for f in &pr.findings {
        let inline = match (&f.path, f.line) {
            (Some(path), Some(line)) => gh(&[
                "api",
                &format!("repos/{repo}/pulls/{n}/comments"),
                "-f",
                &format!("body={}", f.body),
                "-f",
                &format!("commit_id={head}"),
                "-f",
                &format!("path={path}"),
                "-F",
                &format!("line={line}"),
                "-f",
                "side=RIGHT",
            ])
            .is_ok(),
            _ => false,
        };
        // A line outside the diff cannot hold a comment; it goes on the PR itself.
        if !inline {
            let place = match (&f.path, f.line) {
                (Some(path), Some(line)) => format!("`{path}:{line}`\n\n"),
                (Some(path), None) => format!("`{path}`\n\n"),
                _ => String::new(),
            };
            gh(&[
                "api",
                &format!("repos/{repo}/issues/{n}/comments"),
                "-f",
                &format!("body={place}{}", f.body),
            ])?;
        }
    }
    let blocking = pr.findings.iter().any(|f| f.weight.starts_with("bloq"));
    let event = if blocking {
        "REQUEST_CHANGES"
    } else {
        "COMMENT"
    };
    let count = pr.findings.len();
    let body = if count == 1 {
        "1 ponto nos comentários.".to_string()
    } else {
        format!("{count} pontos nos comentários.")
    };
    gh(&[
        "api",
        &format!("repos/{repo}/pulls/{n}/reviews"),
        "-f",
        &format!("event={event}"),
        "-f",
        &format!("commit_id={head}"),
        "-f",
        &format!("body={body}"),
    ])?;
    Ok(done(event, count))
}

/// Publishes what a review run found: comments on the lines, then a review
/// that asks for changes when anything blocks and only comments otherwise.
/// A pull request with no findings gets nothing. Never approves.
#[tauri::command]
pub async fn review_publish(run_id: String) -> Result<Vec<Published>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = findings_path(&run_id).ok_or("no data dir")?;
        let text = fs::read_to_string(&path)
            .map_err(|_| "A revisão não gravou o arquivo de achados.".to_string())?;
        let file: FindingsFile =
            serde_json::from_str(&text).map_err(|e| format!("Arquivo de achados inválido: {e}"))?;
        Ok(file
            .prs
            .iter()
            .map(|pr| {
                publish_pr(pr).unwrap_or_else(|e| Published {
                    repo: pr.repo.clone(),
                    number: pr.number,
                    verdict: "error".into(),
                    comments: 0,
                    error: Some(e),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Closes the user's conversations on a pull request: a "Satisfied" reply,
/// which Reviewable reads as the disposition, and the thread resolved on GitHub.
fn satisfy_threads(repo: &str, number: u64) -> Result<(), String> {
    let me = my_login()?;
    let (owner, name) = repo.split_once('/').ok_or("repositório inválido")?;
    let out = gh(&[
        "api",
        "graphql",
        "-f",
        "query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId author{login} body}}}}}}}",
        "-F",
        &format!("o={owner}"),
        "-F",
        &format!("r={name}"),
        "-F",
        &format!("n={number}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let threads = v["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for thread in threads {
        let comments = thread["comments"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mine = |c: &serde_json::Value| c["author"]["login"].as_str() == Some(me);
        if !comments.iter().any(mine) {
            continue;
        }
        let last = comments.last();
        let satisfied = last.is_some_and(|c| {
            mine(c)
                && c["body"]
                    .as_str()
                    .unwrap_or("")
                    .trim_end()
                    .ends_with("Satisfied")
        });
        if !satisfied {
            if let Some(first) = comments.first().and_then(|c| c["databaseId"].as_u64()) {
                gh(&[
                    "api",
                    &format!("repos/{repo}/pulls/{number}/comments/{first}/replies"),
                    "-f",
                    "body=ok!\n\nSatisfied",
                ])?;
            }
        }
        if thread["isResolved"].as_bool() != Some(true) {
            if let Some(id) = thread["id"].as_str() {
                gh(&[
                    "api",
                    "graphql",
                    "-f",
                    &format!(
                        r#"query=mutation{{resolveReviewThread(input:{{threadId:"{id}"}}){{thread{{id}}}}}}"#
                    ),
                ])?;
            }
        }
    }
    Ok(())
}

/// The user's own verdict on a pull request the bee found nothing in. Approving
/// checks the head is still the one reviewed, then closes the user's conversations.
#[tauri::command]
pub async fn review_verdict(
    repo: String,
    number: u64,
    head: String,
    approve: bool,
    note: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = number.to_string();
        let current = gh(&[
            "pr",
            "view",
            &n,
            "-R",
            &repo,
            "--json",
            "headRefOid",
            "--jq",
            ".headRefOid",
        ])?;
        if current != head {
            return Err(
                "O PR recebeu um commit novo depois da revisão; a abelha revisa de novo.".into(),
            );
        }
        let path = format!("repos/{repo}/pulls/{n}/reviews");
        if approve {
            gh(&[
                "api",
                &path,
                "-f",
                "event=APPROVE",
                "-f",
                &format!("commit_id={head}"),
            ])?;
            satisfy_threads(&repo, number)
        } else {
            let body = note
                .filter(|b| !b.trim().is_empty())
                .unwrap_or_else(|| "Pedido de alterações.".into());
            gh(&[
                "api",
                &path,
                "-f",
                "event=REQUEST_CHANGES",
                "-f",
                &format!("commit_id={head}"),
                "-f",
                &format!("body={body}"),
            ])
            .map(|_| ())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
