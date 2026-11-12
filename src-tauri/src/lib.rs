mod ai;
mod backup;
mod capture;
mod disk;
#[cfg(feature = "native-smoke")]
mod disk_gate;
mod git;
mod http_body;
mod printing;
mod projects;
mod shell;
mod update;
mod vault;
mod window_geometry;

use disk::{collect_argv_paths, collect_paths_from_directory, CapabilityStore, PendingOpenPaths};
use tauri::{Emitter, Manager};

#[cfg(feature = "native-smoke")]
fn smoke_startup_phase(started: std::time::Instant, phase: &str) {
    eprintln!(
        "[mdsh-native-startup] pid={} elapsed_ms={} phase={}",
        std::process::id(),
        started.elapsed().as_millis(),
        phase
    );
}

fn queue_open_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    let paths = collect_paths_from_directory(paths, None);
    if paths.is_empty() {
        return;
    }
    app.state::<PendingOpenPaths>().push_many(paths);
    let _ = app.emit("mdsh://open-paths-pending", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "native-smoke")]
    let started = std::time::Instant::now();
    let pending = PendingOpenPaths::default();
    let argv = collect_argv_paths();
    pending.push_many(argv);

    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            queue_open_paths(
                app,
                collect_paths_from_directory(
                    args.into_iter().skip(1),
                    Some(std::path::Path::new(&cwd)),
                ),
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    #[cfg(feature = "native-smoke")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    let builder = builder
        .manage(pending)
        .manage(CapabilityStore::default())
        .manage(projects::ProjectStore::default())
        .manage(backup::BackupRoots::default())
        .manage(shell::CloseState::default())
        .manage(vault::VaultState::default())
        .manage(ai::AiRequestRegistry::default())
        .manage(capture::CaptureStore::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-policy")
                .on_navigation(|_, url| shell::allowed_navigation(url, cfg!(debug_assertions)))
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            backup::desktop_backup_pick_root,
            backup::desktop_backup_write,
            backup::desktop_backup_cleanup,
            backup::desktop_backup_list,
            backup::desktop_backup_read,
            disk::disk_read,
            disk::disk_write,
            disk::disk_write_bytes,
            disk::disk_stat,
            disk::disk_open_dialog,
            disk::disk_open_directory,
            disk::disk_save_dialog,
            disk::disk_restore_grants,
            disk::disk_forget_grant,
            disk::disk_rename,
            disk::take_pending_open_paths,
            disk::ack_pending_open_paths,
            projects::project_pick_root,
            projects::project_open_root,
            projects::project_refresh,
            projects::project_manifest,
            projects::project_read,
            #[cfg(feature = "native-smoke")]
            projects::project_smoke_calls,
            projects::project_write_text,
            projects::project_write_asset,
            projects::project_rename,
            projects::project_revoke,
            git::git_status,
            git::git_diff,
            git::git_log,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            shell::desktop_open_external,
            shell::desktop_arm_close_guard,
            shell::desktop_ack_close_request,
            shell::desktop_complete_close,
            shell::desktop_smoke_request_close,
            printing::desktop_print,
            shell::desktop_smoke_key,
            shell::desktop_smoke_cancel_dialog,
            update::update_status,
            update::update_check,
            update::update_verify_manifest,
            update::update_install,
            vault::vault_set,
            vault::vault_status,
            vault::vault_delete,
            ai::ai_chat,
            ai::ai_cancel,
            capture::desktop_capture_show,
            capture::desktop_capture_hide,
            capture::desktop_capture_register,
            capture::desktop_capture_unregister,
            capture::desktop_capture_status,
            #[cfg(feature = "native-smoke")]
            window_geometry::desktop_window_geometry,
        ])
        .setup(move |app| {
            app.state::<CapabilityStore>()
                .set_registry(app.path().app_data_dir()?.join("disk-access.json"))?;
            app.state::<backup::BackupRoots>()
                .set_registry(app.path().app_data_dir()?.join("backup-root.json"))?;
            #[cfg(feature = "native-smoke")]
            let project_registry = std::env::var_os("MDSH_NATIVE_PROJECT_REGISTRY")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?.join("project-roots.json"));
            #[cfg(not(feature = "native-smoke"))]
            let project_registry = app.path().app_data_dir()?.join("project-roots.json");
            app.state::<projects::ProjectStore>()
                .set_registry(project_registry)?;
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) =
                    window_geometry::constrain_window(&window, window_geometry::MAIN_MINIMUM)
                {
                    eprintln!("[mdsh-window] could not fit the main window: {error}");
                }
            }
            #[cfg(feature = "native-smoke")]
            smoke_startup_phase(started, "user-setup");
            Ok(())
        });

    #[cfg(feature = "native-smoke")]
    let builder = builder.on_page_load(move |webview, payload| {
        smoke_startup_phase(
            started,
            &format!("page-load:{:?} window={}", payload.event(), webview.label()),
        );
    });

    #[cfg(feature = "native-smoke")]
    smoke_startup_phase(started, "before-build");
    let context = tauri::generate_context!();
    let app = builder
        .build(context)
        .expect("error while building tauri application");
    #[cfg(feature = "native-smoke")]
    smoke_startup_phase(started, "after-build");
    app.run(move |app_handle, event| {
        #[cfg(feature = "native-smoke")]
        if matches!(&event, tauri::RunEvent::Ready) {
            smoke_startup_phase(started, "run-ready");
        }
        match &event {
            tauri::RunEvent::Ready => {
                // The window-state plugin restores a saved size on window
                // creation. Fit the main window after that restore.
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Err(error) =
                        window_geometry::constrain_window(&window, window_geometry::MAIN_MINIMUM)
                    {
                        eprintln!("[mdsh-window] could not fit the main window: {error}");
                    }
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::ScaleFactorChanged { .. },
                ..
            } => {
                if let Some(window) = app_handle.get_webview_window(label) {
                    let minimum = if label == capture::CAPTURE_LABEL {
                        window_geometry::CAPTURE_MINIMUM
                    } else {
                        window_geometry::MAIN_MINIMUM
                    };
                    if let Err(error) = window_geometry::constrain_window(&window, minimum) {
                        eprintln!("[mdsh-window] could not fit {label}: {error}");
                    }
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                if shell::request_close(app_handle) {
                    api.prevent_close();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                if shell::request_close(app_handle) {
                    api.prevent_exit();
                } else {
                    capture::unregister_on_exit(app_handle);
                }
            }
            tauri::RunEvent::Exit => capture::unregister_on_exit(app_handle),
            _ => {}
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            queue_open_paths(app_handle, paths);
        }
    });
}
