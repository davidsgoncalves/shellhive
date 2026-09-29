mod db;
mod errors;
mod files;
mod git;
mod hookclient;
mod hooks;
mod install;
mod mcp;
mod paths;
mod permissions;
mod plugins;
mod pty;
mod sessions;

use tauri::Manager;

/// Hook mode: the executable run by Claude Code in place of the hook scripts.
pub fn hook_client(kind: &str) -> i32 {
    hookclient::run(kind)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyState::default())
        .manage(permissions::Permissions::default())
        .manage(plugins::editor::Editors::default())
        .setup(|app| {
            // Before anything opens the data folder.
            paths::migrate_legacy_data();
            errors::init(app.package_info().version.to_string());
            app.manage(db::open().map_err(|e| format!("database unavailable: {e}"))?);
            if let Err(e) = hooks::write_scripts() {
                eprintln!("[setup] could not write hook scripts: {e}");
            }
            hooks::start_server(app.handle().clone());
            plugins::local::start(app.handle().clone());
            Ok(())
        })
        // The mini panel and detached terminals are asked to close with the
        // main window, but each has to close itself, and on Linux one could
        // linger and keep the process alive. The main window going away ends
        // the app outright.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            hooks::hooks_setup,
            permissions::permission_decide,
            sessions::sessions_list,
            sessions::sessions_search,
            sessions::session_titles,
            db::state_load,
            db::state_save,
            db::metrics_summary,
            git::git_info,
            errors::error_reports_get,
            errors::error_reports_set,
            errors::report_error,
            errors::error_log_tail,
            files::link_open,
            files::path_exists,
            files::drop_save,
            paths::path_check,
            paths::legacy_data_available,
            paths::legacy_data_reimport,
            paths::home_dir,
            install::install_kind,
            install::update_check,
            install::update_install,
            install::restart_app,
            plugins::editor::editor_submit,
            plugins::editor::editor_cancel,
            plugins::plugins_set_enabled,
            plugins::plugin_tool_result,
            plugins::local::local_plugins,
            plugins::local::local_plugins_folder,
            plugins::local::local_plugin_approve,
            plugins::local::local_plugin_remove,
            plugins::local::local_plugin_panel,
            plugins::local::local_plugin_run,
            plugins::local::plugin_storage_get,
            plugins::local::plugin_storage_set,
            plugins::local::plugin_events,
            files::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
