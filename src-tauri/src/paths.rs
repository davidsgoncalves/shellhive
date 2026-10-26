use std::path::Path;

#[derive(serde::Serialize)]
pub struct PathCheck {
    pub exists: bool,
    pub is_dir: bool,
    pub name: Option<String>,
    pub expanded: String,
}

/// Resolves `~` and reports whether the path is usable as a session folder.
#[tauri::command]
pub fn path_check(path: String) -> PathCheck {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().to_string())
            .unwrap_or(path.clone())
    } else if path == "~" {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or(path.clone())
    } else {
        path.clone()
    };

    let p = Path::new(&expanded);
    let meta = std::fs::metadata(p).ok();
    PathCheck {
        exists: meta.is_some(),
        is_dir: meta.map(|m| m.is_dir()).unwrap_or(false),
        name: p.file_name().map(|n| n.to_string_lossy().to_string()),
        expanded,
    }
}

/// Home directory, used as the fallback folder for a new session.
#[tauri::command]
pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".into())
}

/// True when running inside WSL on Windows, where the desktop, the browser and
/// the password prompt belong to Windows rather than to Linux.
pub fn is_wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|r| r.to_lowercase().contains("microsoft"))
            .unwrap_or(false)
}

/// Name of the app's data folder inside the system config dir. The preview
/// build keeps its own, so it runs beside the installed app.
const DATA_DIR: &str = if cfg!(feature = "preview") {
    "shellhive-preview"
} else {
    "shellhive"
};
/// Where versions up to 0.1.21, named Claude Terminal, kept their data.
const LEGACY_DATA_DIR: &str = "claude-terminal";
/// Left by the Sobre option; the next launch copies the legacy data in again.
const REIMPORT_MARKER: &str = "reimport-claude-terminal";

/// The app's data folder, created on first use.
pub fn data_dir() -> Option<std::path::PathBuf> {
    let dir = dirs::config_dir()?.join(DATA_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn legacy_data_dir() -> Option<std::path::PathBuf> {
    Some(dirs::config_dir()?.join(LEGACY_DATA_DIR)).filter(|d| d.is_dir())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Runs before anything opens the data folder. A first launch after the
/// rename copies the Claude Terminal folder over, leaving the original in
/// place as a backup; the Sobre option asks for the same copy again.
pub fn migrate_legacy_data() {
    // The preview build starts empty instead of copying anyone's data.
    if cfg!(feature = "preview") {
        return;
    }
    if let Some(config) = dirs::config_dir() {
        migrate_in(&config);
    }
}

fn migrate_in(config: &Path) {
    let target = config.join(DATA_DIR);
    let legacy = config.join(LEGACY_DATA_DIR);
    if !legacy.is_dir() {
        return;
    }
    let marker = target.join(REIMPORT_MARKER);
    let again = marker.exists();
    if target.is_dir() && !again {
        return;
    }
    match copy_dir(&legacy, &target) {
        Ok(()) => eprintln!(
            "[paths] copied {} into {}",
            legacy.display(),
            target.display()
        ),
        Err(e) => eprintln!("[paths] could not copy the Claude Terminal data: {e}"),
    }
    let _ = std::fs::remove_file(marker);
}

/// True when a Claude Terminal data folder exists to import from.
#[tauri::command]
pub fn legacy_data_available() -> bool {
    legacy_data_dir().is_some()
}

/// Replaces the current data with the Claude Terminal copy, then restarts,
/// since the database is open while the app runs.
#[tauri::command]
pub fn legacy_data_reimport(app: tauri::AppHandle) -> Result<(), String> {
    if legacy_data_dir().is_none() {
        return Err("não há dados do Claude Terminal para importar".into());
    }
    let dir = data_dir().ok_or("no config dir")?;
    std::fs::write(dir.join(REIMPORT_MARKER), "").map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{migrate_in, DATA_DIR, LEGACY_DATA_DIR, REIMPORT_MARKER};
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shellhive-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(LEGACY_DATA_DIR).join("bin")).unwrap();
        fs::write(dir.join(LEGACY_DATA_DIR).join("data.db"), "velho").unwrap();
        fs::write(dir.join(LEGACY_DATA_DIR).join("bin").join("claude"), "shim").unwrap();
        dir
    }

    #[test]
    fn copies_on_first_launch_and_keeps_the_original() {
        let base = scratch("first");
        migrate_in(&base);
        assert_eq!(
            fs::read_to_string(base.join(DATA_DIR).join("data.db")).unwrap(),
            "velho"
        );
        assert!(base.join(DATA_DIR).join("bin").join("claude").exists());
        assert!(base.join(LEGACY_DATA_DIR).join("data.db").exists());
    }

    #[test]
    fn leaves_existing_data_alone() {
        let base = scratch("existing");
        fs::create_dir_all(base.join(DATA_DIR)).unwrap();
        fs::write(base.join(DATA_DIR).join("data.db"), "novo").unwrap();
        migrate_in(&base);
        assert_eq!(
            fs::read_to_string(base.join(DATA_DIR).join("data.db")).unwrap(),
            "novo"
        );
    }

    #[test]
    fn reimports_when_asked() {
        let base = scratch("again");
        fs::create_dir_all(base.join(DATA_DIR)).unwrap();
        fs::write(base.join(DATA_DIR).join("data.db"), "novo").unwrap();
        fs::write(base.join(DATA_DIR).join(REIMPORT_MARKER), "").unwrap();
        migrate_in(&base);
        assert_eq!(
            fs::read_to_string(base.join(DATA_DIR).join("data.db")).unwrap(),
            "velho"
        );
        assert!(!base.join(DATA_DIR).join(REIMPORT_MARKER).exists());
    }
}
