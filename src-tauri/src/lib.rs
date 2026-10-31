mod disk;
#[cfg(feature = "native-smoke")]
mod disk_gate;
mod printing;
mod projects;
mod shell;

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

#[cfg(feature = "native-smoke")]
fn smoke_data_store_identifier() -> [u8; 16] {
    let value = std::env::var("MDSH_SMOKE_DATA_STORE_ID")
        .expect("MDSH_SMOKE_DATA_STORE_ID is required for isolated native smoke data");
    assert_eq!(
        value.len(),
        32,
        "MDSH_SMOKE_DATA_STORE_ID must contain 32 hexadecimal characters"
    );
    let mut identifier = [0_u8; 16];
    for (index, byte) in identifier.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .expect("MDSH_SMOKE_DATA_STORE_ID must contain hexadecimal characters");
    }
    identifier
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
        .manage(shell::CloseState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-policy")
                .on_navigation(|_, url| shell::allowed_navigation(url, cfg!(debug_assertions)))
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
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
            projects::project_read,
            projects::project_write_text,
            projects::project_write_asset,
            projects::project_rename,
            projects::project_revoke,
            shell::desktop_open_external,
            shell::desktop_arm_close_guard,
            shell::desktop_ack_close_request,
            shell::desktop_complete_close,
            shell::desktop_smoke_request_close,
            printing::desktop_print,
            shell::desktop_smoke_key,
            shell::desktop_smoke_cancel_dialog,
        ])
        .setup(move |app| {
            app.state::<CapabilityStore>()
                .set_registry(app.path().app_data_dir()?.join("disk-access.json"))?;
            #[cfg(feature = "native-smoke")]
            let project_registry = std::env::var_os("MDSH_NATIVE_PROJECT_REGISTRY")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?.join("project-roots.json"));
            #[cfg(not(feature = "native-smoke"))]
            let project_registry = app.path().app_data_dir()?.join("project-roots.json");
            app.state::<projects::ProjectStore>()
                .set_registry(project_registry)?;
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
    #[cfg(feature = "native-smoke")]
    let context = {
        let mut context = context;
        let identifier = smoke_data_store_identifier();
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.data_store_identifier = Some(identifier);
            }
        }
        context
    };
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
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                if shell::request_close(app_handle) {
                    api.prevent_close();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } if shell::request_close(app_handle) => {
                api.prevent_exit();
            }
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
