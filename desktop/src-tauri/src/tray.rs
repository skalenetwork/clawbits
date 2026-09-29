//! The menu bar / tray icon. Left-click focuses the window; the menu lists unread
//! channels, then Show and Quit, and the icon carries a dot while any are unread.
//! macOS tints the template silhouette for light and dark. GNOME shows it only with
//! an AppIndicator host; without one the window stays reachable via Super+Shift+C.

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::menu::{link, ChannelLink};

const ICON: Image<'static> = tauri::include_image!("icons/tray-icon.png");
const ICON_UNREAD: Image<'static> = tauri::include_image!("icons/tray-icon-unread.png");

fn menu(app: &AppHandle, unread: &[ChannelLink]) -> tauri::Result<Menu<Wry>> {
    let mut menu = MenuBuilder::new(app);
    for channel in unread {
        menu = menu.item(&link(app, channel)?);
    }
    if !unread.is_empty() {
        menu = menu.separator();
    }
    menu.text("tray-show", "Show Clawbits").text("tray-quit", "Quit Clawbits").build()
}

#[tauri::command]
pub fn set_tray_unread(app: AppHandle, channels: Vec<ChannelLink>) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("main") else { return Ok(()) };
    tray.set_icon_with_as_template(Some(if channels.is_empty() { ICON } else { ICON_UNREAD }), true)?;
    tray.set_menu(Some(menu(&app, &channels)?))
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let tray = TrayIconBuilder::with_id("main")
        .icon(ICON)
        .icon_as_template(true)
        .menu(&menu(app, &[])?)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::focus_main(tray.app_handle());
            }
        })
        .build(app);
    if let Err(err) = tray {
        log::warn!("tray: could not register the status icon ({err}); running background-only");
    }
    Ok(())
}
