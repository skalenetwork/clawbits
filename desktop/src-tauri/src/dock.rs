//! macOS dock badge — exposed to JS as the `set_dock_badge` Tauri command.
//! On non-macOS platforms the command is a no-op (taskbar overlay icons on
//! Windows / Linux are a separate concern, deferred).

#[cfg(target_os = "macos")]
fn apply_badge(count: u32) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else { return };
    let nsapp = NSApplication::sharedApplication(mtm);
    let tile = nsapp.dockTile();
    let label = match count {
        0 => None,
        n if n > 99 => Some(NSString::from_str("99+")),
        n => Some(NSString::from_str(&n.to_string())),
    };
    tile.setBadgeLabel(label.as_deref());
}

#[tauri::command]
pub fn set_dock_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || apply_badge(count))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = count;
    }
    Ok(())
}
