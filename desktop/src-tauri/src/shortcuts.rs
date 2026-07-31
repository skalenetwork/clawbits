//! Global shortcut: Cmd+Shift+C toggles the main window. When the window
//! is focused, hide; otherwise show + focus. Bound at startup; the user
//! can customize the key later via a settings UI.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// The toggle binding (Cmd+Shift+C on macOS, Ctrl+Shift+C on Linux/Win).
/// Not a `const` because `Shortcut::new` isn't const fn — re-derived each
/// call but the value is cheap.
pub fn toggle_window_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::SHIFT.union(Modifiers::SUPER)),
        Code::KeyC,
    )
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event_state: ShortcutState) {
    if event_state != ShortcutState::Pressed {
        return;
    }
    if *shortcut != toggle_window_shortcut() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
