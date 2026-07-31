use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{
        AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem,
        MenuItemBuilder, SubmenuBuilder,
    },
    AppHandle, Emitter, Manager, Runtime,
};

// Embedded at compile time. `scripts/build-icons.mjs` runs in the
// beforeDev/beforeBuild step and regenerates this from the channel's
// source, so the embedded icon always matches the rest of the bundle.
const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");

/// How many slots the "Recent" submenu reserves. Items beyond the Nth
/// most-recent are dropped. Match this to the frontend's tracker cap.
pub const RECENT_SLOTS: usize = 10;

/// Per-channel record held by the menu state so we know what path to
/// emit when the user clicks a Recent slot.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RecentChannel {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Shared state: the current list of recent channels and the menu-item
/// handles whose labels we mutate as the list changes.
pub struct RecentState<R: Runtime> {
    pub items: Mutex<Vec<RecentChannel>>,
    pub slots: Mutex<Vec<MenuItem<R>>>,
}

/// Handle to the "Launch at Login" toggle so the autostart plugin's
/// state and the menu's checkmark stay in sync.
pub struct AutostartMenuItem<R: Runtime>(pub Mutex<Option<CheckMenuItem<R>>>);

fn load_app_icon() -> Image<'static> {
    let decoded = image::load_from_memory(ICON_BYTES)
        .expect("embedded icon.png must be a valid PNG")
        .to_rgba8();
    let (w, h) = (decoded.width(), decoded.height());
    Image::new_owned(decoded.into_raw(), w, h)
}

/// Build the full app menu and return it along with the references the
/// caller needs to keep in `State` for runtime updates (Recent slots,
/// Launch-at-Login checkbox).
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<(Menu<R>, Vec<MenuItem<R>>, CheckMenuItem<R>)> {
    // Channel-aware label for the macOS app menu / About dialog. After
    // unifying the naming convention to the slug form across all
    // channels, productName, mainBinaryName, the Linux .desktop
    // basename, and the macOS .app bundle name all coincide — so we
    // can use productName directly without going through a separate
    // display-name mapping.
    let product = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "clawbits".to_string());

    let about = AboutMetadataBuilder::new()
        .name(Some(product.clone()))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .icon(Some(load_app_icon()))
        .comments(Some("Cloud sharing hub for AI agents."))
        .copyright(Some("© 2026 Clawbits"))
        .website(Some("https://clawbits.ai"))
        .website_label(Some("clawbits.ai"))
        .authors(Some(vec!["Clawbits".to_string()]))
        .license(Some("Proprietary"))
        .build();

    let check_updates =
        MenuItemBuilder::with_id("app-check-updates", "Check for Updates…").build(app)?;

    let launch_at_login = CheckMenuItemBuilder::with_id("app-autostart", "Launch at Login")
        .checked(false)
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, &product)
        .about(Some(about))
        .separator()
        .item(&check_updates)
        .separator()
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

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let back = MenuItemBuilder::with_id("nav-back", "Back")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let forward = MenuItemBuilder::with_id("nav-forward", "Forward")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let reload = MenuItemBuilder::with_id("nav-reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let hard_reload = MenuItemBuilder::with_id("nav-hard-reload", "Hard Reload")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("view-zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view-zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view-zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view_builder = SubmenuBuilder::new(app, "View")
        .item(&back)
        .item(&forward)
        .separator()
        .item(&reload)
        .item(&hard_reload)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset);

    // DevTools is always exposed. The `devtools` Tauri feature is on
    // in Cargo.toml, so this works in release/staging builds too —
    // needed for on-machine diagnostics (notification debug pings,
    // network inspection) where reproducing under `bun run dev` isn't
    // an option.
    let view_builder = {
        let devtools = MenuItemBuilder::with_id("nav-devtools", "Toggle DevTools")
            .accelerator("CmdOrCtrl+Alt+I")
            .build(app)?;
        view_builder.separator().item(&devtools)
    };

    let view_menu = view_builder.build()?;

    // Pre-built slots; labels and enabled state are mutated from
    // set_recent_channels as the frontend pushes updates.
    let recent_slots: Vec<MenuItem<R>> = (0..RECENT_SLOTS)
        .map(|i| {
            MenuItemBuilder::with_id(format!("recent-{i}"), "—")
                .enabled(false)
                .build(app)
        })
        .collect::<Result<_, _>>()?;

    // SubmenuBuilder::items wants `&dyn IsMenuItem`. Collect references
    // separately so the temporary trait-object slice lives long enough.
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = recent_slots
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    let recent_submenu = SubmenuBuilder::new(app, "Recent")
        .items(&recent_refs)
        .build()?;

    let close_window = MenuItemBuilder::with_id("win-close", "Close Window")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let bring_all_to_front = MenuItemBuilder::with_id("win-front", "Bring All to Front")
        .build(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close_window)
        .separator()
        .fullscreen()
        .separator()
        .item(&bring_all_to_front)
        .separator()
        .item(&recent_submenu)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;

    Ok((menu, recent_slots, launch_at_login))
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "nav-back" => {
            let _ = app.emit("desktop://nav", "back");
        }
        "nav-forward" => {
            let _ = app.emit("desktop://nav", "forward");
        }
        "nav-reload" => {
            // JS-side reload preserves React Router unwinds cleanly.
            let _ = app.emit("desktop://nav", "reload");
        }
        "nav-hard-reload" => {
            // Cache-clearing reload — has to be native since JS can't
            // reach the WebKit data store.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.clear_all_browsing_data();
                let _ = window.reload();
            }
        }
        "view-zoom-in" => {
            let _ = app.emit("desktop://zoom", "in");
        }
        "view-zoom-out" => {
            let _ = app.emit("desktop://zoom", "out");
        }
        "view-zoom-reset" => {
            let _ = app.emit("desktop://zoom", "reset");
        }
        "win-close" => {
            // Emit a regular close request. The window-event handler
            // installed in `lib.rs` decides whether that means
            // hide-to-tray (tray present) or actually-exit (GNOME and
            // other tray-less sessions).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        "win-front" => focus_main(app),
        "app-check-updates" => {
            // The frontend (UpdateContext) runs the check and surfaces the
            // banner, or a "you're up to date" toast when there's nothing new.
            let _ = app.emit("desktop://check-update", ());
        }
        "app-autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let manager = app.autolaunch();
            let next = !manager.is_enabled().unwrap_or(false);
            let _ = if next {
                manager.enable()
            } else {
                manager.disable()
            };
            // Re-sync the checkbox from the plugin's view of the world
            // — that's the source of truth (it may have rejected the
            // change, e.g. permissions on macOS).
            if let Some(state) = app.try_state::<AutostartMenuItem<R>>() {
                if let Ok(slot) = state.0.lock() {
                    if let Some(item) = slot.as_ref() {
                        let _ = item.set_checked(manager.is_enabled().unwrap_or(false));
                    }
                }
            }
        }
        "nav-devtools" => {
            if let Some(webview) = app.get_webview_window("main") {
                if webview.is_devtools_open() {
                    webview.close_devtools();
                } else {
                    webview.open_devtools();
                }
            }
        }
        other if other.starts_with("recent-") => {
            let Ok(idx) = other.trim_start_matches("recent-").parse::<usize>() else {
                return;
            };
            let Some(state) = app.try_state::<RecentState<R>>() else {
                return;
            };
            let Ok(items) = state.items.lock() else {
                return;
            };
            if let Some(channel) = items.get(idx) {
                let _ = app.emit("desktop://open-channel", channel.path.clone());
                focus_main(app);
            }
        }
        _ => {}
    }
}
