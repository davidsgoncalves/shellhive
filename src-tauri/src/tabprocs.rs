//! What each tab's shell has started, and the ports those programs listen on,
//! for the processes popup in the top bar.

use std::collections::{HashMap, HashSet};

use sysinfo::{Pid, ProcessesToUpdate, System};

use crate::pty::PtyState;

/// Characters kept of a process's command line.
const COMMAND_MAX: usize = 120;

#[derive(serde::Serialize)]
pub struct TabProcess {
    pub pid: u32,
    pub name: String,
    pub command: String,
    pub ports: Vec<u16>,
}

#[derive(serde::Serialize)]
pub struct TabProcesses {
    pub tab_id: String,
    pub processes: Vec<TabProcess>,
}

/// Everything started under each tab's shell, the shell itself left out.
fn descendants(sys: &System, shells: &[(String, u32)]) -> Vec<(String, Vec<Pid>)> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        if let Some(parent) = p.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    shells
        .iter()
        .map(|(tab, root)| {
            let mut found = Vec::new();
            let mut stack = children
                .get(&Pid::from_u32(*root))
                .cloned()
                .unwrap_or_default();
            while let Some(pid) = stack.pop() {
                found.push(pid);
                if let Some(more) = children.get(&pid) {
                    stack.extend(more);
                }
            }
            found.sort();
            (tab.clone(), found)
        })
        .collect()
}

/// TCP ports each process listens on, from `lsof`.
#[cfg(not(windows))]
fn listening_ports() -> HashMap<u32, Vec<u16>> {
    let mut ports: HashMap<u32, Vec<u16>> = HashMap::new();
    let Ok(out) = crate::process::background("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .output()
    else {
        return ports;
    };
    let mut pid = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse::<u32>().ok();
        } else if let (Some(addr), Some(pid)) = (line.strip_prefix('n'), pid) {
            if let Some(port) = addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
                let list = ports.entry(pid).or_default();
                if !list.contains(&port) {
                    list.push(port);
                }
            }
        }
    }
    ports
}

/// TCP ports each process listens on, from `netstat`.
#[cfg(windows)]
fn listening_ports() -> HashMap<u32, Vec<u16>> {
    let mut ports: HashMap<u32, Vec<u16>> = HashMap::new();
    let Ok(out) = crate::process::background("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
    else {
        return ports;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || cols[3] != "LISTENING" {
            continue;
        }
        let port = cols[1]
            .rsplit(':')
            .next()
            .and_then(|p| p.parse::<u16>().ok());
        if let (Some(port), Ok(pid)) = (port, cols[4].parse::<u32>()) {
            let list = ports.entry(pid).or_default();
            if !list.contains(&port) {
                list.push(port);
            }
        }
    }
    ports
}

#[tauri::command]
pub fn tab_processes(state: tauri::State<PtyState>) -> Vec<TabProcesses> {
    let shells = state.shell_pids();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let ports = listening_ports();
    descendants(&sys, &shells)
        .into_iter()
        .map(|(tab_id, pids)| TabProcesses {
            tab_id,
            processes: pids
                .into_iter()
                .filter_map(|pid| {
                    let p = sys.process(pid)?;
                    let command = p
                        .cmd()
                        .iter()
                        .map(|a| a.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ");
                    let mut listening = ports.get(&pid.as_u32()).cloned().unwrap_or_default();
                    listening.sort();
                    Some(TabProcess {
                        pid: pid.as_u32(),
                        name: p.name().to_string_lossy().to_string(),
                        command: command.chars().take(COMMAND_MAX).collect(),
                        ports: listening,
                    })
                })
                .collect(),
        })
        .collect()
}

/// Ends a program a tab started. Only those are accepted, never a tab's
/// shell or anything outside the tabs.
#[tauri::command]
pub fn process_kill(state: tauri::State<PtyState>, pid: u32) -> Result<(), String> {
    let shells = state.shell_pids();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let allowed: HashSet<Pid> = descendants(&sys, &shells)
        .into_iter()
        .flat_map(|(_, pids)| pids)
        .collect();
    let pid = Pid::from_u32(pid);
    if !allowed.contains(&pid) {
        return Err("processo não pertence a uma aba".into());
    }
    let process = sys.process(pid).ok_or("processo já terminou")?;
    // A polite stop first, where the system has one.
    if process.kill_with(sysinfo::Signal::Term) != Some(true) && !process.kill() {
        return Err("não foi possível encerrar o processo".into());
    }
    Ok(())
}
