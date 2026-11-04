//! Global quick-capture window for the desktop shell.
//!
//! The global shortcut is opt-in. The frontend registers it through a command,
//! so the application and the native smoke test do not depend on an operating
//! system hotkey. The window is created on first use and reused after that.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const CAPTURE_LABEL: &str = "capture";
const CAPTURE_TITLE: &str = "DeckMark quick capture";
const CAPTURE_QUERY: &str = "capture=1";
const CAPTURE_RESET_EVENT: &str = "mdsh://capture-reset";
const CAPTURE_WIDTH: f64 = 560.0;
const CAPTURE_HEIGHT: f64 = 420.0;

/// Stored accelerator for the opt-in global shortcut.
#[derive(Default)]
pub struct CaptureStore(Mutex<Option<String>>);

/// Registration state returned to the frontend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub registered: bool,
    pub shortcut: Option<String>,
}

impl CaptureStore {
    fn shortcut(&self) -> Option<String> {
        self.0.lock().ok().and_then(|value| value.clone())
    }

    fn set(&self, shortcut: Option<String>) {
        if let Ok(mut value) = self.0.lock() {
            *value = shortcut;
        }
    }

    pub fn status(&self) -> CaptureStatus {
        let shortcut = self.shortcut();
        CaptureStatus {
            registered: shortcut.is_some(),
            shortcut,
        }
    }
}

/// Parses an accelerator with the plugin parser before any registration.
pub fn parse_accelerator(value: &str) -> Result<Shortcut, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("The shortcut is empty.".to_string());
    }
    Shortcut::from_str(trimmed).map_err(|error| format!("Invalid shortcut: {error}"))
}

fn capture_url(app: &AppHandle) -> Result<Url, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    let mut url = main.url().map_err(|error| error.to_string())?;
    url.set_query(Some(CAPTURE_QUERY));
    Ok(url)
}

fn create_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let url = capture_url(app)?;
    let builder = WebviewWindowBuilder::new(app, CAPTURE_LABEL, WebviewUrl::External(url))
        .title(CAPTURE_TITLE)
        .inner_size(CAPTURE_WIDTH, CAPTURE_HEIGHT)
        .center()
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false);
    builder.build().map_err(|error| error.to_string())
}

/// Shows the capture window. A known window is restored and focused.
pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        let was_visible = window.is_visible().unwrap_or(false);
        window.show().map_err(|error| error.to_string())?;
        let _ = window.unminimize();
        window.set_focus().map_err(|error| error.to_string())?;
        // A hidden window keeps its frontend state. Reset it on the next use.
        if !was_visible {
            let _ = app.emit_to(CAPTURE_LABEL, CAPTURE_RESET_EVENT, ());
        }
        return Ok(());
    }
    let window = create_window(app)?;
    let _ = window.set_focus();
    Ok(())
}

/// Unregisters the shortcut on application exit.
pub fn unregister_on_exit(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<CaptureStore>().set(None);
}

#[tauri::command]
pub async fn desktop_capture_show(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub async fn desktop_capture_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_capture_register(
    app: AppHandle,
    state: tauri::State<'_, CaptureStore>,
    shortcut: String,
) -> Result<(), String> {
    let parsed = parse_accelerator(&shortcut)?;
    let normalized = shortcut.trim().to_string();
    if state.shortcut().as_deref() == Some(normalized.as_str()) {
        return Ok(());
    }
    if state.shortcut().is_some() {
        app.global_shortcut()
            .unregister_all()
            .map_err(|error| error.to_string())?;
        state.set(None);
    }
    app.global_shortcut()
        .on_shortcut(parsed, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(error) = show(app) {
                    eprintln!("[mdsh-capture] could not show the window: {error}");
                }
            }
        })
        .map_err(|error| error.to_string())?;
    state.set(Some(normalized));
    Ok(())
}

#[tauri::command]
pub fn desktop_capture_unregister(
    app: AppHandle,
    state: tauri::State<'_, CaptureStore>,
) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    state.set(None);
    Ok(())
}

#[tauri::command]
pub fn desktop_capture_status(state: tauri::State<'_, CaptureStore>) -> CaptureStatus {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_defaults_to_unregistered() {
        let store = CaptureStore::default();
        assert_eq!(
            store.status(),
            CaptureStatus {
                registered: false,
                shortcut: None,
            }
        );
    }

    #[test]
    fn status_reports_the_stored_shortcut() {
        let store = CaptureStore::default();
        store.set(Some("CommandOrControl+Shift+Space".to_string()));
        assert_eq!(
            store.status(),
            CaptureStatus {
                registered: true,
                shortcut: Some("CommandOrControl+Shift+Space".to_string()),
            }
        );
    }

    #[test]
    fn accepts_the_default_accelerator() {
        assert!(parse_accelerator("CommandOrControl+Shift+Space").is_ok());
        assert!(parse_accelerator("Control+Alt+KeyK").is_ok());
        assert!(parse_accelerator("  F8  ").is_ok());
    }

    #[test]
    fn rejects_empty_and_unknown_accelerators() {
        assert_eq!(
            parse_accelerator("   "),
            Err("The shortcut is empty.".to_string())
        );
        assert!(parse_accelerator("NotAKey").is_err());
        assert!(parse_accelerator("CommandOrControl+Shift+Nope").is_err());
    }
}
