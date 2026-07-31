//! System tray icon for Clawbits. Left-click focuses the window; the menu
//! offers Show / Quit. On macOS this lives in the menu bar and is rendered
//! as a TEMPLATE image: a black-on-transparent silhouette that macOS tints
//! automatically for light/dark mode (and inverts when the menu is open).
//!
//! On Linux the tray is rendered by KDE / Cinnamon / MATE / XFCE / Unity
//! out of the box, and by GNOME **when** an AppIndicator /
//! StatusNotifierItem host is present — which Ubuntu's default GNOME
//! provides via its pre-installed AppIndicator extension. We always
//! *attempt* to register the icon: on a bare GNOME session with no SNI
//! host it simply isn't shown (registration itself doesn't error). Either
//! way the app keeps running when its window is closed (hide-to-background
//! is wired unconditionally in `lib.rs`), so a missing tray no longer
//! means a dead app — the window stays reachable via the Ctrl+Shift+C
//! global shortcut, GNOME's Background Apps menu (24.04+), or relaunch.

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// Monochrome black-on-transparent PNG embedded at compile time. macOS
/// treats this as a template image (see `.icon_as_template(true)` below)
/// and recolors it based on appearance state.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("tray-show", "Show Clawbits").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit Clawbits")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    // Decode the embedded PNG to raw RGBA so tauri::Image::new can take it.
    // (tauri 2.11's Image has no from_bytes; from_path needs runtime I/O.)
    // The PNG is a build-time asset — a corrupt file means the build is
    // broken, so `expect` is appropriate.
    let decoded = image::load_from_memory(TRAY_ICON_BYTES)
        .expect("embedded tray-icon.png must be a valid PNG")
        .to_rgba8();
    let (w, h) = (decoded.width(), decoded.height());
    let icon = Image::new_owned(decoded.into_raw(), w, h);

    // Always attempt to register the tray. On macOS / Windows and
    // SNI-capable Linux desktops (KDE, XFCE, Cinnamon, MATE, Unity, and
    // Ubuntu's default GNOME) it renders a Show / Quit icon; on a bare
    // GNOME session with no StatusNotifierItem host the item is exported
    // but never displayed, and registration does not error. A genuine
    // failure is logged and tolerated — the app still runs in the
    // background with the close-to-hide handler from `lib.rs`, reachable
    // via the global shortcut, GNOME's Background Apps menu, or relaunch.
    if let Err(err) = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => focus_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click anywhere on the tray icon focuses the window;
            // right-click already opens the menu via the platform default.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)
    {
        log::warn!(
            "tray: could not register status icon ({err}); running background-only \
             (reopen via Ctrl+Shift+C, GNOME Background Apps, or relaunch)"
        );
    }
    Ok(())
}
