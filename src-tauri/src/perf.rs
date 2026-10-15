//! Performance history for diagnosing slowness. Every 30 seconds the app
//! notes what it and its child processes use, and how the system is doing,
//! keeping the last 30 minutes in memory. Nothing leaves the machine until
//! the user sends a diagnostic from Sobre; process names are kept, command
//! lines and paths never are.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sysinfo::{Pid, ProcessesToUpdate, System};

const EVERY: Duration = Duration::from_secs(30);
const KEEP: usize = 60;

#[derive(Clone, Default, serde::Serialize)]
pub struct Group {
    count: usize,
    /// Percent of one core, summed over the group.
    cpu: f32,
    /// Resident memory in MB.
    mem_mb: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct Sample {
    /// Seconds since the epoch.
    at: u64,
    /// The app's own process.
    app: Group,
    /// The web view drawing the interface (its own processes on Linux).
    webview: Group,
    /// Agent sessions running in the tabs.
    claude: Group,
    /// Shells and anything else the tabs started.
    other: Group,
    system_cpu: f32,
    load_1m: f64,
    mem_available_mb: u64,
    swap_used_mb: u64,
}

static HISTORY: Mutex<VecDeque<Sample>> = Mutex::new(VecDeque::new());

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const MB: u64 = 1024 * 1024;

/// What kind of process a child of the app is, from its name only.
fn kind(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("webkit") || lower.contains("webview") {
        "webview"
    } else if lower.contains("claude") || lower == "node" {
        "claude"
    } else {
        "other"
    }
}

fn sample(sys: &mut System) -> Sample {
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let me = Pid::from_u32(std::process::id());
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        if let Some(parent) = p.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut groups: HashMap<&'static str, Group> = HashMap::new();
    let mut stack = children.get(&me).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if let Some(p) = sys.process(pid) {
            let g = groups.entry(kind(&p.name().to_string_lossy())).or_default();
            g.count += 1;
            g.cpu += p.cpu_usage();
            g.mem_mb += p.memory() / MB;
        }
        if let Some(more) = children.get(&pid) {
            stack.extend(more);
        }
    }
    let app = sys
        .process(me)
        .map(|p| Group {
            count: 1,
            cpu: p.cpu_usage(),
            mem_mb: p.memory() / MB,
        })
        .unwrap_or_default();
    Sample {
        at: now(),
        app,
        webview: groups.remove("webview").unwrap_or_default(),
        claude: groups.remove("claude").unwrap_or_default(),
        other: groups.remove("other").unwrap_or_default(),
        system_cpu: sys.global_cpu_usage(),
        load_1m: System::load_average().one,
        mem_available_mb: sys.available_memory() / MB,
        swap_used_mb: sys.used_swap() / MB,
    }
}

/// Starts the sampler; a sample right away would read CPU as zero, so the
/// first one waits a full interval.
pub fn start() {
    thread::spawn(|| {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        loop {
            thread::sleep(EVERY);
            let s = sample(&mut sys);
            let mut history = HISTORY.lock().unwrap();
            history.push_back(s);
            while history.len() > KEEP {
                history.pop_front();
            }
        }
    });
}

/// What describes the machine, without anything that names the user.
fn machine() -> serde_json::Value {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let env = |k: &str| std::env::var(k).ok();
    serde_json::json!({
        "os": System::long_os_version(),
        "kernel": System::kernel_version(),
        "arch": std::env::consts::ARCH,
        "cpus": sys.cpus().len(),
        "cpu_model": sys.cpus().first().map(|c| c.brand().trim().to_string()),
        "mem_total_mb": sys.total_memory() / MB,
        "swap_total_mb": sys.total_swap() / MB,
        "session_type": env("XDG_SESSION_TYPE"),
        "desktop": env("XDG_CURRENT_DESKTOP"),
        "webkit_dmabuf_disabled": env("WEBKIT_DISABLE_DMABUF_RENDERER"),
        "webkit_compositing_disabled": env("WEBKIT_DISABLE_COMPOSITING_MODE"),
    })
}

/// Sends the history, a sample of right now, the machine and what the
/// interface reports about itself to Sentry. Returns the event id.
#[tauri::command]
pub async fn perf_report(ui: serde_json::Value) -> Result<String, String> {
    if !crate::errors::sending() {
        return Err("ligue \"Enviar\" em Relatórios de erro para mandar o diagnóstico".into());
    }
    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        thread::sleep(Duration::from_millis(500));
        let current = sample(&mut sys);
        let history: Vec<Sample> = HISTORY.lock().unwrap().iter().cloned().collect();
        serde_json::json!({
            "now": current,
            "history": history,
            "machine": machine(),
            "interface": ui,
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let text = crate::errors::scrub(&report.to_string());
    let report: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(crate::errors::send_diagnostic(report))
}

#[cfg(test)]
mod tests {
    use super::{kind, sample};
    use sysinfo::System;

    #[test]
    fn children_are_grouped_by_name() {
        assert_eq!(kind("WebKitWebProcess"), "webview");
        assert_eq!(kind("claude"), "claude");
        assert_eq!(kind("node"), "claude");
        assert_eq!(kind("zsh"), "other");
    }

    #[test]
    fn a_sample_sees_this_process_and_the_system() {
        let mut sys = System::new();
        let s = sample(&mut sys);
        assert_eq!(s.app.count, 1);
        assert!(s.app.mem_mb > 0);
        println!("{}", serde_json::to_string(&s).unwrap());
    }
}
