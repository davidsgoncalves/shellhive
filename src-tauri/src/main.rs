// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Claude Code runs this same executable as a hook on Windows; see hookclient.rs.
    if args.get(1).map(String::as_str) == Some("--hook") {
        let kind = args.get(2).map(String::as_str).unwrap_or("");
        std::process::exit(shellhive_lib::hook_client(kind));
    }
    // WebKitGTK's DMABUF renderer makes the window flicker and freeze on many
    // Linux setups (NVIDIA drivers, Wayland). Off unless the user chose.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    shellhive_lib::run()
}
