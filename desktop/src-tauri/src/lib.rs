use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

mod dock;
mod menu;
mod notifications;
mod shortcuts;
mod tray;

/// Each build registers only its own scheme, but one recognizer serves every channel.
const DEEP_LINK_PREFIXES: &[&str] = &["clawbits://", "clawbits-staging://", "clawbits-dev://"];

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn set_zoom(app: AppHandle, scale: f64) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("main window not found")?
        .set_zoom(scale.clamp(0.5, 3.0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_recent_channels(
    items: Vec<menu::RecentChannel>,
    state: tauri::State<'_, menu::RecentState<tauri::Wry>>,
) -> Result<(), String> {
    let slots = state.slots.lock().map_err(|e| e.to_string())?;
    for (i, slot) in slots.iter().enumerate() {
        let item = items.get(i);
        slot.set_text(item.map_or("—", |item| item.name.as_str()))
            .map_err(|e| e.to_string())?;
        slot.set_enabled(item.is_some()).map_err(|e| e.to_string())?;
    }
    *state.items.lock().map_err(|e| e.to_string())? = items;
    Ok(())
}

// NSUserNotification needs the main thread; Linux queues onto its notifier thread and must stay off the main one.
#[cfg(target_os = "macos")]
fn deliver_notification(app: &AppHandle, job: impl FnOnce() + Send + 'static) -> Result<(), String> {
    app.run_on_main_thread(job).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn deliver_notification(_app: &AppHandle, job: impl FnOnce() + Send + 'static) -> Result<(), String> {
    job();
    Ok(())
}

// `async` keeps these off the main thread, where sync commands run: a D-Bus wait could freeze the window for 25s.
#[tauri::command(async)]
fn notify_channel_message(app: AppHandle, message: notifications::ChannelMessage) -> Result<(), String> {
    deliver_notification(&app, move || notifications::deliver(&message))
}

#[tauri::command(async)]
fn notify_debug_ping(app: AppHandle) -> Result<(), String> {
    deliver_notification(&app, notifications::debug_ping)
}

#[tauri::command]
async fn notify_diagnostics() -> Result<notifications::Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(notifications::diagnostics)
        .await
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // First, so relaunches (including OAuth deep links from the browser) funnel into the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main(app);
            for arg in argv {
                if DEEP_LINK_PREFIXES.iter().any(|prefix| arg.starts_with(prefix)) {
                    let _ = app.emit("clawbits://deep-link", arg);
                }
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                // Info in release too: the log file is how Linux notification issues get diagnosed.
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("clawbits".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| shortcuts::handle(app, shortcut, event.state()))
                .build(),
        )
        .setup(|app| {
            log::info!(
                "=== clawbits boot: v{} identifier={} binary={} ===",
                env!("CARGO_PKG_VERSION"),
                app.config().identifier,
                app.config().main_binary_name.as_deref().unwrap_or("(unset)"),
            );
            if let Ok(log_dir) = app.path().app_log_dir() {
                log::info!("log directory: {}", log_dir.display());
            }

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = handle.emit("clawbits://deep-link", url.to_string());
                }
            });

            tray::build(app.handle())?;
            let _ = app.global_shortcut().register(shortcuts::toggle_window_shortcut());

            let (built_menu, recent_slots, autostart_check) = menu::build(app.handle())?;
            app.set_menu(built_menu)?;
            let _ = autostart_check.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
            app.manage(menu::RecentState::<tauri::Wry> {
                items: Mutex::new(Vec::new()),
                slots: Mutex::new(recent_slots),
            });
            app.manage(menu::AutostartMenuItem::<tauri::Wry>(Mutex::new(Some(autostart_check))));

            // An unbundled dev binary borrows Terminal's notification identity.
            #[cfg(target_os = "macos")]
            if tauri::is_dev() {
                if let Err(err) = mac_notification_sys::set_application("com.apple.Terminal") {
                    log::warn!("set_application(Terminal) failed: {err}");
                }
            }
            notifications::request_authorization_if_prod();

            // Closing hides the window, so the webview and the SSE stream behind notifications keep running.
            if let Some(window) = app.get_webview_window("main") {
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }

            #[cfg(target_os = "linux")]
            {
                let config = app.config();
                let binary = config.main_binary_name.clone().unwrap_or_else(|| "clawbits".to_string());
                let product_name = config.product_name.clone().unwrap_or_else(|| binary.clone());
                // WebKitGTK can reset the title to the WRY default before the first paint.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&binary);
                }
                notifications::set_app_identity(&binary, &product_name);
                let handle = app.handle().clone();
                notifications::set_activation_handler(move |channel_id| {
                    let _ = handle.emit("clawbits://notification-activated", channel_id);
                    let main = handle.clone();
                    let _ = handle.run_on_main_thread(move || focus_main(&main));
                });
                notifications::ensure_appimage_desktop_integration();
                notifications::log_linux_environment(&binary, &product_name, &config.identifier);
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            dock::set_dock_badge,
            set_zoom,
            set_recent_channels,
            notify_channel_message,
            notify_debug_ping,
            notify_diagnostics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // A hidden window leaves nothing for AppKit to bring forward on a dock click.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                focus_main(_app);
            }
        });
}
