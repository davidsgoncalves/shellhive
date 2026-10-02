use std::process::Command;

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// How this build was installed, which decides how it can update itself.
#[tauri::command]
pub fn install_kind() -> String {
    if !cfg!(target_os = "linux") {
        return "native".into();
    }
    if std::env::var("APPIMAGE").is_ok() {
        return "appimage".into();
    }
    "package".into()
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} não pôde ser executado: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{program} falhou")
    } else {
        stderr
    })
}

/// Entry of the .deb build in the updater manifest.
const DEB_TARGET: &str = "linux-x86_64-deb";

/// Manifest of the beta channel: always the newest release, beta or not, so
/// people in the beta also get every regular version.
const BETA_ENDPOINT: &str =
    "https://github.com/davidsgoncalves/shellhive/releases/download/beta-channel/latest.json";

/// Looks for a newer release in the chosen channel. The check runs in Rust:
/// the webview cannot read release files, GitHub sends no CORS headers for
/// them, and the JS updater cannot switch endpoints.
async fn find_update(
    app: &AppHandle,
    beta: bool,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let mut builder = app.updater_builder();
    // A package install is replaced by a newer .deb, not by the updater bundle.
    if install_kind() == "package" {
        builder = builder.target(DEB_TARGET);
    }
    if beta {
        let url = tauri::Url::parse(BETA_ENDPOINT).map_err(|e| e.to_string())?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Version of a newer release in the channel, or None when this one is current.
#[tauri::command]
pub async fn update_check(app: AppHandle, beta: bool) -> Result<Option<String>, String> {
    Ok(find_update(&app, beta).await?.map(|u| u.version))
}

/// Downloads the newer release, checks its signature and installs it,
/// reporting progress as `update-progress` in percent. Returns "installed"
/// when a restart finishes the job.
#[tauri::command]
pub async fn update_install(app: AppHandle, beta: bool) -> Result<String, String> {
    let update = find_update(&app, beta)
        .await?
        .ok_or("nenhuma atualização disponível")?;
    let progress = app.clone();
    let mut got: u64 = 0;
    let on_chunk = move |chunk: usize, total: Option<u64>| {
        got += chunk as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let _ = progress.emit("update-progress", got * 100 / total);
        }
    };
    if install_kind() != "package" {
        update
            .download_and_install(on_chunk, || {})
            .await
            .map_err(|e| e.to_string())?;
        return Ok("installed".into());
    }
    let file_name = update
        .download_url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("update.deb")
        .to_string();
    let bytes = update
        .download(on_chunk, || {})
        .await
        .map_err(|e| format!("download falhou: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || install_package(file_name, bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes the downloaded package to a temporary file and installs it.
///
/// A package install needs root, so this asks the desktop for authorisation
/// through polkit. Ubuntu's graphical installer cannot upgrade an installed
/// package, so a failure returns the command to run instead.
fn install_package(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("download vazio".into());
    }
    let safe = file_name
        .rsplit('/')
        .next()
        .unwrap_or("update.deb")
        .replace(
            |c: char| !c.is_ascii_alphanumeric() && !"._-".contains(c),
            "_",
        );
    let path = std::env::temp_dir().join(safe);
    std::fs::write(&path, bytes).map_err(|e| format!("não consegui gravar o pacote: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let by_hand = format!("sudo apt install '{path_str}'");
    // WSL has no polkit agent to ask for the password, so the user installs
    // it from a terminal tab.
    if crate::paths::is_wsl() {
        return Err(format!(
            "no WSL o app não consegue pedir sua senha. Rode numa aba: {by_hand}"
        ));
    }
    if !which("pkexec") {
        return Err(format!(
            "o sistema não tem como pedir sua senha (pkexec). Rode numa aba: {by_hand}"
        ));
    }
    // dpkg orders 1.3.0-beta.7 after 1.3.0, so leaving a beta for the
    // release looks like a downgrade, which apt refuses under -y. The updater
    // already checked the signature and that the version is newer. The lock
    // timeout waits out an unattended upgrade instead of failing.
    run(
        "pkexec",
        &[
            "apt-get",
            "install",
            "-y",
            "--allow-downgrades",
            "-o",
            "DPkg::Lock::Timeout=120",
            &path_str,
        ],
    )
    .map_err(|e| {
        // apt prints notes before the error; the last line says what failed.
        let reason = e.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(&e);
        format!("a instalação falhou ({reason}). Rode numa aba: {by_hand}")
    })?;
    Ok("installed".into())
}

fn which(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {program}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Restarts the app after an update.
///
/// On macOS the updater replaces the whole bundle, which leaves the running
/// executable path pointing at a file that no longer exists, so re-executing it
/// does nothing. Asking the system to open the bundle again works instead.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // .../Claude Terminal.app/Contents/MacOS/<bin>
        let bundle = exe
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"));
        if let Some(bundle) = bundle {
            Command::new("open")
                .arg("-n")
                .arg(bundle)
                .spawn()
                .map_err(|e| format!("não consegui reabrir o app: {e}"))?;
            app.exit(0);
            return Ok(());
        }
    }
    tauri::process::restart(&tauri::Manager::env(&app));
}
