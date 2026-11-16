//! The Git plugin's backend: what each worktree holds, diffs, staging,
//! commits and pushes, merge conflicts, worktrees, and the snapshots taken
//! around each agent turn so a turn can be reviewed and undone.
//!
//! Snapshots never touch the user's index, HEAD or branches: they are built
//! in a copy of the index and kept as loose commits under
//! `refs/shellhive/turns/`, out of every branch.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

/// Turns kept, across tabs; the snapshots of older ones are dropped.
const KEEP_TURNS: usize = 60;
/// Prompt characters kept to name a turn.
const PROMPT_CHARS: usize = 160;

struct Out {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

fn run(cwd: &str, args: &[&str], env: &[(&str, &str)], input: Option<&[u8]>) -> Out {
    let mut cmd = crate::process::background("git");
    cmd.arg("-C").arg(cwd).args(args);
    // Never wait on an editor, a pager or a credential prompt.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let Ok(mut child) = cmd.spawn() else {
        return Out {
            ok: false,
            stdout: Vec::new(),
            stderr: "git não encontrado".into(),
        };
    };
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(data);
    }
    match child.wait_with_output() {
        Ok(o) => Out {
            ok: o.status.success(),
            stdout: o.stdout,
            stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
        },
        Err(e) => Out {
            ok: false,
            stdout: Vec::new(),
            stderr: e.to_string(),
        },
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = run(cwd, args, &[], None);
    out.ok
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
    git(cwd, args)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Runs git and turns a failure into its message.
fn git_do(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = run(cwd, args, &[], None);
    if out.ok {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else if out.stderr.is_empty() {
        Err(format!("git {} falhou", args.first().unwrap_or(&"")))
    } else {
        Err(out.stderr)
    }
}

fn toplevel(dir: &str) -> Option<String> {
    git_line(dir, &["rev-parse", "--show-toplevel"])
}

/// The repository a worktree belongs to: the folder holding its shared `.git`.
fn repo_of(root: &str) -> String {
    let common = git_line(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .unwrap_or_else(|| format!("{root}/.git"));
    common
        .strip_suffix("/.git")
        .map(str::to_string)
        .unwrap_or(common)
}

// ---------------------------------------------------------------------------
// The per-tab line

#[derive(serde::Serialize)]
pub struct GitInfo {
    pub branch: String,
    /// Lines added and removed against HEAD, staged or not.
    pub added: u64,
    pub removed: u64,
    /// Changed paths, untracked ones included.
    pub files: u64,
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

// ---------------------------------------------------------------------------
// Worktrees a tab touched

/// The folder a path lives in, walking up until one exists.
fn folder_of(p: &str) -> String {
    let mut dir = PathBuf::from(p);
    if !dir.is_dir() {
        dir.pop();
    }
    while !dir.exists() {
        if !dir.pop() {
            break;
        }
    }
    dir.to_string_lossy().to_string()
}

/// Worktree roots the agent of a tab touched, most recent first, with the
/// time of the last touch.
fn touched_roots(tab_id: &str) -> Vec<(String, u64)> {
    let mut seen: HashMap<String, u64> = HashMap::new();
    let mut folders: HashMap<String, Option<String>> = HashMap::new();
    for e in super::events::recent() {
        if e.tab_id.as_deref() != Some(tab_id) {
            continue;
        }
        let mut dirs: Vec<String> = e.paths.iter().map(|p| folder_of(p)).collect();
        if e.kind == "tool" && e.action.as_deref() == Some("command") {
            if let Some(cwd) = &e.cwd {
                dirs.push(cwd.clone());
            }
        }
        for dir in dirs {
            let root = folders
                .entry(dir.clone())
                .or_insert_with(|| toplevel(&dir))
                .clone();
            if let Some(root) = root {
                let at = seen.entry(root).or_insert(0);
                *at = (*at).max(e.at);
            }
        }
    }
    let mut list: Vec<(String, u64)> = seen.into_iter().collect();
    list.sort_by_key(|t| std::cmp::Reverse(t.1));
    list
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    root: String,
    last_at: u64,
}

/// Worktrees the agent of a tab touched, plus the folders given (the tab's
/// own and the worktrees it created), resolved to their roots.
#[tauri::command]
pub async fn git_tab_worktrees(tab_id: String, extra: Vec<String>) -> Vec<Touched> {
    let mut list: Vec<Touched> = touched_roots(&tab_id)
        .into_iter()
        .map(|(root, last_at)| Touched { root, last_at })
        .collect();
    for dir in extra {
        if !Path::new(&dir).is_dir() {
            continue;
        }
        if let Some(root) = toplevel(&dir) {
            if !list.iter().any(|t| t.root == root) {
                list.push(Touched { root, last_at: 0 });
            }
        }
    }
    list
}

// ---------------------------------------------------------------------------
// Status

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    path: String,
    /// The old path of a rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    /// Index column of `git status`: M, A, D, R, U or space.
    staged: String,
    /// Worktree column: M, D, U, ? or space.
    unstaged: String,
    conflict: bool,
    untracked: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    root: String,
    /// Folder holding the repository's shared `.git`.
    repo: String,
    /// Whether this is the repository's main worktree.
    main: bool,
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    /// A merge, rebase, cherry-pick or revert in progress.
    operation: Option<String>,
    files: Vec<FileStatus>,
    /// Ref the diff against a base starts from by default.
    default_base: Option<String>,
}

fn operation(root: &str) -> Option<String> {
    let git_dir = git_line(root, &["rev-parse", "--path-format=absolute", "--git-dir"])?;
    let dir = Path::new(&git_dir);
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        return Some("rebase".into());
    }
    for (file, name) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        if dir.join(file).exists() {
            return Some(name.into());
        }
    }
    None
}

fn default_base(root: &str) -> Option<String> {
    if let Some(r) = git_line(
        root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        return Some(r);
    }
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|r| git_line(root, &["rev-parse", "--verify", "--quiet", r]).is_some())
        .map(str::to_string)
}

fn parse_status(raw: &str) -> Vec<FileStatus> {
    // `-z` entries: "XY path", and a rename is followed by its old path.
    let mut parts = raw.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = &entry[0..1];
        let y = &entry[1..2];
        let path = entry[3..].to_string();
        let from = if x == "R" || x == "C" {
            parts.next().map(str::to_string)
        } else {
            None
        };
        let conflict = x == "U" || y == "U" || (x == "A" && y == "A") || (x == "D" && y == "D");
        let untracked = x == "?";
        files.push(FileStatus {
            path,
            from,
            staged: if untracked { " ".into() } else { x.into() },
            unstaged: y.into(),
            conflict,
            untracked,
        });
    }
    files
}

#[tauri::command]
pub async fn git_worktree_info(root: String) -> Result<WorktreeInfo, String> {
    if !Path::new(&root).is_dir() {
        return Err("pasta não encontrada".into());
    }
    let raw = git_do(&root, &["status", "--porcelain=v1", "-z", "-uall"])?;
    let repo = repo_of(&root);
    let branch = git_line(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let upstream = git_line(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let (mut ahead, mut behind) = (None, None);
    if upstream.is_some() {
        if let Some(counts) = git_line(
            &root,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        ) {
            let mut it = counts.split_whitespace().map(|n| n.parse::<u32>().ok());
            behind = it.next().flatten();
            ahead = it.next().flatten();
        }
    }
    Ok(WorktreeInfo {
        main: Path::new(&repo) == Path::new(&root),
        repo,
        head: git_line(&root, &["rev-parse", "--short", "HEAD"]),
        branch,
        upstream,
        ahead,
        behind,
        operation: operation(&root),
        files: parse_status(&raw),
        default_base: default_base(&root),
        root,
    })
}

/// Local and remote branches, for the base picker.
#[tauri::command]
pub async fn git_refs(root: String) -> Vec<String> {
    git(
        &root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .map(|s| {
        s.lines()
            .filter(|l| !l.ends_with("/HEAD") && !l.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Diffs

const DIFF_FLAGS: &[&str] = &["--no-color", "--no-ext-diff", "-M"];

fn untracked(root: &str) -> Vec<String> {
    git(root, &["ls-files", "--others", "--exclude-standard", "-z"])
        .map(|s| {
            s.split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A new-file diff for an untracked path. `--no-index` exits 1 when the
/// files differ, which is always here.
fn untracked_diff(root: &str, path: &str) -> String {
    let out = run(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-index",
            "--",
            "/dev/null",
            path,
        ],
        &[],
        None,
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn with_untracked(root: &str, mut diff: String, path: Option<&str>) -> String {
    for file in untracked(root) {
        if path.is_some_and(|p| p != file) {
            continue;
        }
        diff.push_str(&untracked_diff(root, &file));
    }
    diff
}

/// A unified diff of one kind:
/// - "unstaged": index to working tree, untracked files included;
/// - "staged": HEAD to index;
/// - "base": the merge base with `base` to the working tree, untracked included;
/// - "range": commit `base` to commit `to`.
#[tauri::command]
pub async fn git_diff(
    root: String,
    kind: String,
    base: Option<String>,
    to: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["diff".into()];
    args.extend(DIFF_FLAGS.iter().map(|s| s.to_string()));
    let with_new = match kind.as_str() {
        "unstaged" => true,
        "staged" => {
            args.push("--cached".into());
            false
        }
        "base" => {
            let base = base.ok_or("informe a base")?;
            let from = git_line(&root, &["merge-base", &base, "HEAD"])
                .or_else(|| git_line(&root, &["rev-parse", "--verify", &base]))
                .ok_or_else(|| format!("{base} não existe neste repositório"))?;
            args.push(from);
            true
        }
        "range" => {
            args.push(base.ok_or("informe o início")?);
            args.push(to.ok_or("informe o fim")?);
            false
        }
        _ => return Err("tipo de diff desconhecido".into()),
    };
    args.push("--".into());
    if let Some(p) = &path {
        args.push(p.clone());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let diff = git_do(&root, &refs)?;
    Ok(if with_new {
        with_untracked(&root, diff, path.as_deref())
    } else {
        diff
    })
}

// ---------------------------------------------------------------------------
// Staging and discarding

/// Applies a patch built by the interface: to the index (`cached`), or
/// reversed onto the working tree to discard.
#[tauri::command]
pub async fn git_apply(
    root: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    let mut args = vec!["apply", "--whitespace=nowarn", "--unidiff-zero"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    let out = run(&root, &args, &[], Some(patch.as_bytes()));
    if out.ok {
        Ok(())
    } else {
        Err(out.stderr)
    }
}

/// Stages, unstages or discards whole files. Discarding drops what is not
/// staged: a tracked file goes back to its staged content, a new one is deleted.
#[tauri::command]
pub async fn git_files(root: String, action: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let with = |head: &[&str]| -> Vec<String> {
        head.iter()
            .map(|s| s.to_string())
            .chain(std::iter::once("--".to_string()))
            .chain(paths.iter().cloned())
            .collect()
    };
    let run_list = |args: Vec<String>| -> Result<(), String> {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_do(&root, &refs).map(|_| ())
    };
    match action.as_str() {
        "stage" => run_list(with(&["add", "-A"])),
        "unstage" => {
            // A repo without commits has nothing to restore from.
            if git_line(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_some() {
                run_list(with(&["restore", "--staged"]))
            } else {
                run_list(with(&["rm", "--cached", "-r", "--quiet"]))
            }
        }
        "discard" => {
            let new: HashSet<String> = untracked(&root).into_iter().collect();
            let (fresh, tracked): (Vec<String>, Vec<String>) =
                paths.iter().cloned().partition(|p| new.contains(p));
            for p in fresh {
                let full = Path::new(&root).join(&p);
                fs::remove_file(&full).map_err(|e| format!("{p}: {e}"))?;
            }
            if tracked.is_empty() {
                return Ok(());
            }
            let mut args: Vec<String> = ["restore", "--worktree", "--"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            args.extend(tracked);
            run_list(args)
        }
        _ => Err("ação desconhecida".into()),
    }
}

// ---------------------------------------------------------------------------
// Commit and push

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("escreva a mensagem do commit".into());
    }
    let out = run(&root, &["commit", "-F", "-"], &[], Some(message.as_bytes()));
    if !out.ok {
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if out.stderr.is_empty() {
            stdout
        } else {
            out.stderr
        });
    }
    Ok(git_line(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default())
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    let has_upstream = git_line(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_some();
    let args: &[&str] = if has_upstream {
        &["push"]
    } else {
        &["push", "-u", "origin", "HEAD"]
    };
    let out = run(&root, args, &[], None);
    if out.ok {
        Ok(out.stderr)
    } else {
        Err(out.stderr)
    }
}

// ---------------------------------------------------------------------------
// Merge conflicts

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// The file with markers rebuilt from stages 1 to 3, base sections included.
    merged: String,
    /// The file as it is now in the working tree.
    current: String,
    /// Whether the working tree still holds conflict markers.
    has_markers: bool,
}

fn stage_blob(root: &str, stage: u8, path: &str) -> Vec<u8> {
    let spec = format!(":{stage}:{path}");
    let out = run(root, &["show", &spec], &[], None);
    if out.ok {
        out.stdout
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub async fn git_conflict(root: String, path: String) -> Result<Conflict, String> {
    let dir = std::env::temp_dir().join(format!("shellhive-merge-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let names = ["ours", "base", "theirs"];
    for (name, stage) in names.iter().zip([2u8, 1, 3]) {
        fs::write(dir.join(name), stage_blob(&root, stage, &path)).map_err(|e| e.to_string())?;
    }
    let file = |n: &str| dir.join(n).to_string_lossy().to_string();
    let out = run(
        &root,
        &[
            "merge-file",
            "-p",
            "--diff3",
            "-L",
            "nosso",
            "-L",
            "base",
            "-L",
            "deles",
            &file("ours"),
            &file("base"),
            &file("theirs"),
        ],
        &[],
        None,
    );
    let _ = fs::remove_dir_all(&dir);
    let current = fs::read_to_string(Path::new(&root).join(&path)).unwrap_or_default();
    Ok(Conflict {
        merged: String::from_utf8_lossy(&out.stdout).into_owned(),
        has_markers: current.lines().any(|l| l.starts_with("<<<<<<<")),
        current,
    })
}

/// Writes a resolved file and marks it resolved.
#[tauri::command]
pub async fn git_resolve(
    root: String,
    path: String,
    content: Option<String>,
) -> Result<(), String> {
    if let Some(content) = content {
        fs::write(Path::new(&root).join(&path), content).map_err(|e| e.to_string())?;
    }
    git_do(&root, &["add", "--", &path]).map(|_| ())
}

// ---------------------------------------------------------------------------
// Worktrees

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(['-', '.', '/'])
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

/// Keeps `.worktrees/` out of `git status` without touching `.gitignore`.
fn exclude_worktrees(repo: &str) {
    let Some(common) = git_line(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return;
    };
    let file = Path::new(&common).join("info").join("exclude");
    let current = fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|l| l.trim() == "/.worktrees/") {
        return;
    }
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = fs::write(&file, format!("{current}{sep}/.worktrees/\n"));
}

/// Creates `<repo>/.worktrees/<name>` on a new branch `<name>` from `base`.
#[tauri::command]
pub async fn git_worktree_add(
    repo: String,
    name: String,
    base: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err("use só letras, números, - _ . e /".into());
    }
    let repo = repo_of(&repo);
    let folder = name.replace('/', "-");
    let path = Path::new(&repo).join(".worktrees").join(&folder);
    if path.exists() {
        return Err(format!("{} já existe", path.display()));
    }
    exclude_worktrees(&repo);
    let path_s = path.to_string_lossy().to_string();
    let exists = git_line(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .is_some();
    let mut args = vec!["worktree", "add"];
    if exists {
        args.extend([path_s.as_str(), name.as_str()]);
    } else {
        args.extend(["-b", name.as_str(), path_s.as_str()]);
        if let Some(b) = base.as_deref().filter(|b| !b.is_empty()) {
            args.push(b);
        }
    }
    git_do(&repo, &args)?;
    Ok(path_s)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheck {
    exists: bool,
    branch: Option<String>,
    /// Changed files that removing the worktree would lose.
    dirty: u32,
    /// Commits not on any remote.
    unpushed: u32,
}

#[tauri::command]
pub async fn git_worktree_check(root: String) -> WorktreeCheck {
    if !Path::new(&root).is_dir() {
        return WorktreeCheck {
            exists: false,
            branch: None,
            dirty: 0,
            unpushed: 0,
        };
    }
    let dirty = git(&root, &["status", "--porcelain"])
        .map(|s| s.lines().count() as u32)
        .unwrap_or(0);
    let unpushed = git_line(
        &root,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
    )
    .and_then(|n| n.parse().ok())
    .unwrap_or(0);
    WorktreeCheck {
        exists: true,
        branch: git_line(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
        dirty,
        unpushed,
    }
}

/// Removes a worktree; with `delete_branch`, its branch too.
#[tauri::command]
pub async fn git_worktree_remove(
    repo: String,
    root: String,
    branch: Option<String>,
    delete_branch: bool,
) -> Result<(), String> {
    if Path::new(&root).is_dir() {
        git_do(&repo, &["worktree", "remove", "--force", &root])?;
    } else {
        let _ = git(&repo, &["worktree", "prune"]);
    }
    if delete_branch {
        if let Some(b) = branch.filter(|b| !b.is_empty()) {
            git_do(&repo, &["branch", "-D", &b])?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Turn snapshots

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTree {
    root: String,
    /// Snapshot commit before the turn touched this worktree.
    from: String,
    /// Snapshot commit when the turn ended.
    #[serde(default)]
    to: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    id: String,
    tab_id: String,
    prompt: String,
    started_at: u64,
    #[serde(default)]
    ended_at: Option<u64>,
    trees: Vec<TurnTree>,
    /// Set once the user undid it.
    #[serde(default)]
    undone: bool,
}

static TURNS: Mutex<Option<Vec<Turn>>> = Mutex::new(None);

fn turns_path() -> Option<PathBuf> {
    Some(
        crate::paths::data_dir()?
            .join("plugin-data")
            .join("git-turns.json"),
    )
}

fn with_turns<T>(f: impl FnOnce(&mut Vec<Turn>) -> T) -> T {
    let mut guard = TURNS.lock().unwrap();
    let turns = guard.get_or_insert_with(|| {
        turns_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    f(turns)
}

fn save_turns(turns: &[Turn]) {
    let Some(path) = turns_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(turns) {
        let _ = fs::write(path, json);
    }
}

fn short_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}

fn snapshot_ref(turn: &str, root: &str, end: bool) -> String {
    format!(
        "refs/shellhive/turns/{turn}/{}/{}",
        short_hash(root),
        if end { "end" } else { "start" }
    )
}

/// Records the working tree, untracked files included, as a commit kept
/// under `ref_name`. Works on a copy of the index, so the user's staging is
/// left as it was.
fn snapshot(root: &str, ref_name: &str) -> Option<String> {
    let index = git_line(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?;
    let tmp = std::env::temp_dir().join(format!(
        "shellhive-index-{}-{}",
        std::process::id(),
        crate::hooks::next_public_id()
    ));
    if Path::new(&index).exists() {
        fs::copy(&index, &tmp).ok()?;
    }
    let tmp_s = tmp.to_string_lossy().to_string();
    let env = [
        ("GIT_INDEX_FILE", tmp_s.as_str()),
        ("GIT_AUTHOR_NAME", "Shellhive"),
        ("GIT_AUTHOR_EMAIL", "shellhive@localhost"),
        ("GIT_COMMITTER_NAME", "Shellhive"),
        ("GIT_COMMITTER_EMAIL", "shellhive@localhost"),
    ];
    let result = (|| {
        if !run(root, &["add", "-A"], &env, None).ok {
            return None;
        }
        let tree = run(root, &["write-tree"], &env, None);
        if !tree.ok {
            return None;
        }
        let tree = String::from_utf8_lossy(&tree.stdout).trim().to_string();
        let mut args = vec![
            "commit-tree",
            tree.as_str(),
            "-m",
            "Shellhive turn snapshot",
        ];
        let head = git_line(root, &["rev-parse", "--verify", "--quiet", "HEAD"]);
        if let Some(h) = &head {
            args.extend(["-p", h.as_str()]);
        }
        let commit = run(root, &args, &env, None);
        if !commit.ok {
            return None;
        }
        let commit = String::from_utf8_lossy(&commit.stdout).trim().to_string();
        run(root, &["update-ref", ref_name, &commit], &[], None)
            .ok
            .then_some(commit)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

fn drop_snapshots(turn: &Turn) {
    for t in &turn.trees {
        if !Path::new(&t.root).is_dir() {
            continue;
        }
        for end in [false, true] {
            let _ = run(
                &t.root,
                &["update-ref", "-d", &snapshot_ref(&turn.id, &t.root, end)],
                &[],
                None,
            );
        }
    }
}

fn open_turn(tab_id: &str) -> Option<usize> {
    with_turns(|turns| {
        turns
            .iter()
            .rposition(|t| t.tab_id == tab_id && t.ended_at.is_none())
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnChanged {
    tab_id: String,
}

fn changed(app: &AppHandle, tab_id: &str) {
    let _ = app.emit(
        "git-turns-changed",
        TurnChanged {
            tab_id: tab_id.to_string(),
        },
    );
}

/// Adds a worktree to the open turn of a tab, snapshotting it first.
fn track(turn_id: &str, root: &str) {
    let known = with_turns(|turns| {
        turns
            .iter()
            .find(|t| t.id == turn_id)
            .is_none_or(|t| t.trees.iter().any(|w| w.root == root))
    });
    if known {
        return;
    }
    // Claimed before the snapshot, so a second caller does not take another.
    with_turns(|turns| {
        if let Some(t) = turns.iter_mut().find(|t| t.id == turn_id) {
            t.trees.push(TurnTree {
                root: root.to_string(),
                from: String::new(),
                to: None,
            });
        }
    });
    let from = snapshot(root, &snapshot_ref(turn_id, root, false));
    with_turns(|turns| {
        if let Some(t) = turns.iter_mut().find(|t| t.id == turn_id) {
            match from {
                Some(from) => {
                    if let Some(w) = t.trees.iter_mut().find(|w| w.root == root) {
                        w.from = from;
                    }
                }
                None => t.trees.retain(|w| w.root != root),
            }
        }
    });
}

/// Opens a turn and returns its id; the worktrees it starts with are
/// snapshotted by `track_start`.
fn start_turn(tab_id: &str, at: u64, prompt: &str) -> String {
    // A turn that never saw its end is closed as it stands.
    if let Some(i) = open_turn(tab_id) {
        with_turns(|turns| turns[i].ended_at = Some(at));
    }
    let id = format!("{at}-{}", crate::hooks::next_public_id());
    let dropped = with_turns(|turns| {
        turns.push(Turn {
            id: id.clone(),
            tab_id: tab_id.to_string(),
            prompt: prompt.chars().take(PROMPT_CHARS).collect(),
            started_at: at,
            ended_at: None,
            trees: Vec::new(),
            undone: false,
        });
        let extra = turns.len().saturating_sub(KEEP_TURNS);
        turns.drain(..extra).collect::<Vec<_>>()
    });
    for t in &dropped {
        drop_snapshots(t);
    }
    id
}

/// Snapshots the worktrees a turn starts with: those the tab touched before
/// and the folder the agent is in.
fn track_start(turn_id: &str, tab_id: &str, cwd: Option<&str>) {
    let mut roots: Vec<String> = touched_roots(tab_id).into_iter().map(|(r, _)| r).collect();
    if let Some(root) = cwd.and_then(toplevel) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    for root in roots {
        track(turn_id, &root);
    }
    with_turns(|turns| save_turns(turns));
}

fn end_turn(tab_id: &str, at: u64) {
    let Some(i) = open_turn(tab_id) else { return };
    let (id, trees) = with_turns(|turns| {
        turns[i].ended_at = Some(at);
        (turns[i].id.clone(), turns[i].trees.clone())
    });
    // A worktree whose start snapshot never landed has nothing to compare.
    let ends: Vec<(String, Option<String>)> = trees
        .iter()
        .filter(|w| !w.from.is_empty())
        .map(|w| {
            (
                w.root.clone(),
                snapshot(&w.root, &snapshot_ref(&id, &w.root, true)),
            )
        })
        .collect();
    with_turns(|turns| {
        if let Some(t) = turns.iter_mut().find(|t| t.id == id) {
            for (root, to) in ends {
                if let Some(w) = t.trees.iter_mut().find(|w| w.root == root) {
                    w.to = to;
                }
            }
            // A turn that changed nothing is not worth listing.
            let same = |w: &TurnTree| {
                w.to.as_deref().is_some_and(|to| {
                    let tree =
                        |c: &str| git_line(&w.root, &["rev-parse", &format!("{c}^{{tree}}")]);
                    tree(&w.from) == tree(to)
                })
            };
            if t.trees.iter().all(same) {
                let empty = t.clone();
                turns.retain(|x| x.id != id);
                drop_snapshots(&empty);
            }
        }
        save_turns(turns);
    });
}

fn is_edit_tool(name: &str) -> bool {
    matches!(
        name,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "apply_patch"
    )
}

/// Follows the agent's turns: snapshots at the start, before its first edit
/// in a worktree new to the turn, and at the end. Called for every hook
/// event while the Git plugin is on. The pre-edit snapshot runs before the
/// hook answers, so it always comes before the change; the start ones run in
/// the background.
pub fn on_hook(app: &AppHandle, tab_id: Option<&str>, at: u64, payload: &serde_json::Value) {
    if !super::id_enabled("git") {
        return;
    }
    let Some(tab_id) = tab_id else { return };
    let Some(name) = payload.get("hook_event_name").and_then(|v| v.as_str()) else {
        return;
    };
    let cwd = payload.get("cwd").and_then(|v| v.as_str());
    match name {
        "UserPromptSubmit" => {
            let prompt = payload.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let turn_id = start_turn(tab_id, at, prompt);
            // In the background, so a large repository never holds up the
            // agent; it takes seconds before its first edit anyway.
            let app = app.clone();
            let tab_id = tab_id.to_string();
            let cwd = cwd.map(str::to_string);
            std::thread::spawn(move || {
                track_start(&turn_id, &tab_id, cwd.as_deref());
                changed(&app, &tab_id);
            });
        }
        "PreToolUse" => {
            let tool = payload
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !is_edit_tool(tool) {
                return;
            }
            let Some(i) = open_turn(tab_id) else { return };
            let turn_id = with_turns(|turns| turns[i].id.clone());
            let input = payload.get("tool_input").cloned().unwrap_or_default();
            for key in ["file_path", "notebook_path", "path"] {
                let Some(p) = input.get(key).and_then(|v| v.as_str()) else {
                    continue;
                };
                let full = match cwd {
                    Some(dir) if Path::new(p).is_relative() => {
                        Path::new(dir).join(p).to_string_lossy().to_string()
                    }
                    _ => p.to_string(),
                };
                if let Some(root) = toplevel(&folder_of(&full)) {
                    track(&turn_id, &root);
                }
            }
            with_turns(|turns| save_turns(turns));
        }
        "Stop" => {
            let app = app.clone();
            let tab_id = tab_id.to_string();
            std::thread::spawn(move || {
                end_turn(&tab_id, at);
                changed(&app, &tab_id);
            });
        }
        _ => {}
    }
}

#[tauri::command]
pub fn git_turns(tab_id: String) -> Vec<Turn> {
    with_turns(|turns| {
        turns
            .iter()
            .filter(|t| t.tab_id == tab_id)
            .rev()
            .cloned()
            .collect()
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    restored: Vec<String>,
    /// Changed again after the turn ended, so left alone.
    skipped: Vec<String>,
}

fn blob_at(root: &str, commit: &str, path: &str) -> Option<String> {
    git_line(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{commit}:{path}"),
        ],
    )
}

fn hash_file(root: &str, path: &str) -> Option<String> {
    let full = Path::new(root).join(path);
    if !full.is_file() {
        return None;
    }
    git_line(root, &["hash-object", "--", path])
}

/// Puts back the files a turn changed in one worktree, as they were before
/// it. A file changed again since the turn ended is skipped. HEAD, branches
/// and the index are left alone.
fn undo_tree(w: &TurnTree) -> Result<UndoResult, String> {
    let to = w.to.as_deref().ok_or("o turno ainda não terminou")?;
    if w.from.is_empty() {
        return Err("o turno não tem o ponto de partida desta worktree".into());
    }
    let names = git_do(
        &w.root,
        &["diff", "--name-only", "-z", "--no-renames", &w.from, to],
    )?;
    let mut result = UndoResult {
        restored: Vec::new(),
        skipped: Vec::new(),
    };
    for path in names.split('\0').filter(|p| !p.is_empty()) {
        if hash_file(&w.root, path) != blob_at(&w.root, to, path) {
            result.skipped.push(path.to_string());
            continue;
        }
        let full = Path::new(&w.root).join(path);
        match blob_at(&w.root, &w.from, path) {
            Some(blob) => {
                let out = run(&w.root, &["cat-file", "blob", &blob], &[], None);
                if !out.ok {
                    return Err(out.stderr);
                }
                if let Some(parent) = full.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&full, out.stdout).map_err(|e| format!("{path}: {e}"))?;
            }
            None => {
                fs::remove_file(&full).map_err(|e| format!("{path}: {e}"))?;
            }
        }
        result.restored.push(path.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_undo_turn(turn_id: String) -> Result<UndoResult, String> {
    let turn = with_turns(|turns| turns.iter().find(|t| t.id == turn_id).cloned())
        .ok_or("turno não encontrado")?;
    let mut all = UndoResult {
        restored: Vec::new(),
        skipped: Vec::new(),
    };
    let many = turn.trees.len() > 1;
    for w in &turn.trees {
        let r = undo_tree(w)?;
        let name = Path::new(&w.root)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let label = |p: String| if many { format!("{name}/{p}") } else { p };
        all.restored.extend(r.restored.into_iter().map(label));
        all.skipped.extend(r.skipped.into_iter().map(label));
    }
    with_turns(|turns| {
        if let Some(t) = turns.iter_mut().find(|t| t.id == turn_id) {
            t.undone = true;
        }
        save_turns(turns);
    });
    Ok(all)
}

/// Lines each turn of any tab added in a worktree, by file, for marking what
/// came from the agent. A guess by content: later edits can move or reuse
/// the same text.
#[tauri::command]
pub async fn git_agent_lines(root: String) -> BTreeMap<String, Vec<String>> {
    let trees: Vec<TurnTree> = with_turns(|turns| {
        turns
            .iter()
            .filter(|t| !t.undone)
            .flat_map(|t| {
                t.trees
                    .iter()
                    .filter(|w| w.root == root && w.to.is_some() && !w.from.is_empty())
                    .cloned()
            })
            .collect()
    });
    let mut lines: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for w in trees {
        let Some(diff) = git(
            &root,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "-U0",
                &w.from,
                w.to.as_deref().unwrap_or(""),
            ],
        ) else {
            continue;
        };
        let mut file: Option<String> = None;
        for l in diff.lines() {
            if let Some(p) = l.strip_prefix("+++ b/") {
                file = Some(p.to_string());
            } else if l.starts_with("+++ ") {
                file = None;
            } else if let (Some(f), Some(text)) = (&file, l.strip_prefix('+')) {
                if !text.trim().is_empty() {
                    lines.entry(f.clone()).or_default().insert(text.to_string());
                }
            }
        }
    }
    lines
        .into_iter()
        .map(|(k, v)| (k, v.into_iter().collect()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellhive-git-test-{}-{}",
            std::process::id(),
            crate::hooks::next_public_id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        git_do(&d, &["init", "-q", "-b", "main"]).unwrap();
        git_do(&d, &["config", "user.email", "t@t"]).unwrap();
        git_do(&d, &["config", "user.name", "t"]).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_do(&d, &["add", "."]).unwrap();
        git_do(&d, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn status_reads_renames_and_untracked() {
        let raw = "R  new.txt\0old.txt\0?? fresh.txt\0UU both.txt\0";
        let files = parse_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].from.as_deref(), Some("old.txt"));
        assert!(files[1].untracked);
        assert!(files[2].conflict);
    }

    #[test]
    fn snapshot_leaves_the_index_alone_and_undo_skips_later_edits() {
        let dir = repo();
        let d = dir.to_string_lossy().to_string();
        fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git_do(&d, &["add", "a.txt"]).unwrap();
        let staged_before = git(&d, &["diff", "--cached", "--name-only"]).unwrap();

        let from = snapshot(&d, "refs/shellhive/test/start").unwrap();
        fs::write(dir.join("a.txt"), "agent\n").unwrap();
        fs::write(dir.join("b.txt"), "agent new\n").unwrap();
        fs::write(dir.join("c.txt"), "agent new\n").unwrap();
        let to = snapshot(&d, "refs/shellhive/test/end").unwrap();
        assert_eq!(
            git(&d, &["diff", "--cached", "--name-only"]).unwrap(),
            staged_before
        );

        // The user changes one of the agent's files after the turn.
        fs::write(dir.join("c.txt"), "user edit\n").unwrap();
        let r = undo_tree(&TurnTree {
            root: d.clone(),
            from,
            to: Some(to),
        })
        .unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "staged\n");
        assert!(!dir.join("b.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.join("c.txt")).unwrap(),
            "user edit\n"
        );
        assert_eq!(r.skipped, vec!["c.txt".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_keeps_what_is_staged() {
        let dir = repo();
        let d = dir.to_string_lossy().to_string();
        fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git_do(&d, &["add", "a.txt"]).unwrap();
        fs::write(dir.join("a.txt"), "staged\nunstaged\n").unwrap();
        fs::write(dir.join("new.txt"), "x\n").unwrap();
        tauri::async_runtime::block_on(git_files(
            d.clone(),
            "discard".into(),
            vec!["a.txt".into(), "new.txt".into()],
        ))
        .unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "staged\n");
        assert!(!dir.join("new.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn worktrees_live_in_the_repo_and_leave_with_their_branch() {
        let dir = repo();
        let d = dir.to_string_lossy().to_string();
        use tauri::async_runtime::block_on as block;
        let root = block(git_worktree_add(d.clone(), "feat/x".into(), None)).unwrap();
        assert!(root.ends_with("/.worktrees/feat-x"));
        assert!(git(&d, &["status", "--porcelain"]).unwrap().is_empty());
        assert_eq!(repo_of(&root), repo_of(&d));
        block(git_worktree_remove(
            d.clone(),
            root.clone(),
            Some("feat/x".into()),
            true,
        ))
        .unwrap();
        assert!(!Path::new(&root).exists());
        assert!(git_line(
            &d,
            &["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"]
        )
        .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn worktree_names_stay_inside_the_folder() {
        assert!(valid_name("feat/login"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("-x"));
        assert!(!valid_name("a b"));
    }
}
