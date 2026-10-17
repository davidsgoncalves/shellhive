use std::path::Path;

#[derive(serde::Serialize)]
pub struct GitInfo {
    pub branch: String,
    /// Lines added and removed against HEAD, staged or not.
    pub added: u64,
    pub removed: u64,
    /// Changed paths, untracked ones included.
    pub files: u64,
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = crate::process::background("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Branch and pending changes of the repository holding `cwd`, if any.
#[tauri::command]
pub async fn git_info(cwd: String) -> Option<GitInfo> {
    if !Path::new(&cwd).is_dir() {
        return None;
    }
    let status = git(&cwd, &["status", "--porcelain=v1", "--branch"])?;
    let mut lines = status.lines();
    let head = lines.next()?.trim_start_matches("## ");
    let branch = if let Some(rest) = head.strip_prefix("No commits yet on ") {
        rest.to_string()
    } else {
        head.split("...").next().unwrap_or(head).to_string()
    };
    let files = lines.count() as u64;

    let (mut added, mut removed) = (0, 0);
    // A repo without commits has no HEAD to diff against.
    if let Some(numstat) = git(&cwd, &["diff", "--numstat", "HEAD"]) {
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            // Binary files report "-" and count as zero lines.
            added += cols.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
            removed += cols.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        }
    }
    Some(GitInfo {
        branch,
        added,
        removed,
        files,
    })
}
