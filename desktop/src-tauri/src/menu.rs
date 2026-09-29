use serde::Deserialize;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent,
    MenuItem, MenuItemBuilder, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

/// A menu entry that opens a route: Window > Recent and the tray's unread list.
#[derive(Deserialize)]
pub struct ChannelLink {
    name: String,
    path: String,
}

/// Ids with this prefix carry the route they open.
const OPEN: &str = "open:";

pub fn link(app: &AppHandle, link: &ChannelLink) -> tauri::Result<MenuItem<Wry>> {
    MenuItemBuilder::with_id(format!("{OPEN}{}", link.path), &link.name).build(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, accelerator: &str| {
        MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app)
    };
    let bundle = &app.config().bundle;
    let product = app.config().product_name.clone().unwrap_or_default();
    let about = AboutMetadataBuilder::new()
        .name(Some(&product))
        .version(Some(app.package_info().version.to_string()))
        .comments(bundle.short_description.clone())
        .copyright(bundle.copyright.clone())
        .website(bundle.homepage.clone())
        .website_label(Some("clawbits.ai"))
        .authors(bundle.publisher.clone().map(|publisher| vec![publisher]))
        .license(Some("Proprietary"));
    // macOS shows the bundle's own icon when none is given; GTK needs one.
    #[cfg(target_os = "linux")]
    let about = about.icon(Some(tauri::include_image!("icons/128x128.png")));

    let launch_at_login = CheckMenuItemBuilder::with_id("app-autostart", "Launch at Login")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let recent = SubmenuBuilder::new(app, "Recent").enabled(false).build()?;
    app.manage(launch_at_login.clone());
    app.manage(recent.clone());

    let app_menu = SubmenuBuilder::new(app, &product)
        .about(Some(about.build()))
        .separator()
        .text("app-check-updates", "Check for Updates…")
        .separator()
        .item(&item("app-settings", "Settings…", "CmdOrCtrl+,")?)
        .item(&launch_at_login)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&item("file-new-agent", "New Agent", "CmdOrCtrl+N")?)
        .separator()
        // Custom, not predefined: muda has no Close Window on Linux.
        .item(&item("win-close", "Close Window", "CmdOrCtrl+W")?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&item("nav-back", "Back", "CmdOrCtrl+[")?)
        .item(&item("nav-forward", "Forward", "CmdOrCtrl+]")?)
        .separator()
        .item(&item("nav-reload", "Reload", "CmdOrCtrl+R")?)
        .separator()
        .item(&item("view-zoom-in", "Zoom In", "CmdOrCtrl+=")?)
        .item(&item("view-zoom-out", "Zoom Out", "CmdOrCtrl+-")?)
        .item(&item("view-zoom-reset", "Actual Size", "CmdOrCtrl+0")?)
        .separator()
        .fullscreen()
        .separator()
        // In release builds too, for on-machine diagnostics.
        .item(&item("nav-devtools", "Toggle DevTools", "CmdOrCtrl+Alt+I")?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .separator()
        .item(&recent)
        .build()?;
    // AppKit then adds the window list and the tiling items.
    #[cfg(target_os = "macos")]
    window_menu.set_as_windows_menu_for_nsapp()?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .text("help-docs", "Documentation")
        .text("help-changelog", "What's New")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

#[tauri::command]
pub fn set_recent_channels(app: AppHandle, channels: Vec<ChannelLink>) -> tauri::Result<()> {
    let recent = app.state::<Submenu<Wry>>();
    while recent.remove_at(0)?.is_some() {}
    for channel in &channels {
        recent.append(&link(&app, channel)?)?;
    }
    recent.set_enabled(!channels.is_empty())
}

/// Every menu click, app menu and tray alike.
pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    let emit = |event: &str, payload: &str| {
        let _ = app.emit(event, payload);
    };
    let open_url = |url: &str| {
        if let Err(err) = app.opener().open_url(url, None::<&str>) {
            log::warn!("menu: could not open {url}: {err}");
        }
    };
    let window = app.get_webview_window("main");
    match event.id().as_ref() {
        "app-settings" => crate::navigate(app, "/settings"),
        "file-new-agent" => crate::navigate(app, "/setup/agent"),
        "nav-back" => crate::navigate(app, "back"),
        "nav-forward" => crate::navigate(app, "forward"),
        "view-zoom-in" => emit("desktop://zoom", "in"),
        "view-zoom-out" => emit("desktop://zoom", "out"),
        "view-zoom-reset" => emit("desktop://zoom", "reset"),
        // The frontend runs the check and shows the banner or a "you're up to date" toast.
        "app-check-updates" => emit("desktop://check-update", ""),
        "help-docs" => open_url("https://clawbits.ai/docs"),
        "help-changelog" => open_url("https://clawbits.ai/changelog"),
        "tray-show" => crate::focus_main(app),
        "tray-quit" => app.exit(0),
        "nav-reload" => {
            let _ = window.map(|window| window.reload());
        }
        // A regular close request, which lib.rs turns into hide.
        "win-close" => {
            let _ = window.map(|window| window.close());
        }
        "nav-devtools" => {
            if let Some(window) = window {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "app-autostart" => {
            let autolaunch = app.autolaunch();
            let _ = if autolaunch.is_enabled().unwrap_or(false) {
                autolaunch.disable()
            } else {
                autolaunch.enable()
            };
            // The plugin is the source of truth: macOS may have refused.
            let _ = app.state::<CheckMenuItem<Wry>>().set_checked(autolaunch.is_enabled().unwrap_or(false));
        }
        id => {
            if let Some(path) = id.strip_prefix(OPEN) {
                crate::navigate(app, path);
            }
        }
    }
}
