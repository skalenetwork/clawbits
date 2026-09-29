use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};

mod menu;
mod notifications;
mod tray;

use notifications::Activation;

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A route, or "back" / "forward", through react-router; brings the window up.
fn navigate(app: &AppHandle, to: &str) {
    let _ = app.emit("desktop://navigate", to);
    focus_main(app);
}

pub fn run() {
    tauri::Builder::default()
        // First, so relaunches (OAuth deep links from the browser included) reach the running
        // window; its deep-link feature hands their URL to on_open_url below.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus_main(app)))
        .plugin(
            tauri_plugin_log::Builder::default()
                // Info in release too: the log file is how Linux notification issues get diagnosed.
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: Some("clawbits".into()) }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let slug = app.config().main_binary_name.clone().unwrap_or_else(|| "clawbits".into());
            log::info!("=== clawbits boot: v{} {slug} ({}) ===", app.package_info().version, app.config().identifier);

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = handle.emit("clawbits://deep-link", url.to_string());
                }
            });
            tray::build(app.handle())?;
            app.set_menu(menu::build(app.handle())?)?;
            // Hides the window when it has focus, brings it up otherwise.
            let _ = app.global_shortcut().on_shortcut("Super+Shift+C", |app, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                match app.get_webview_window("main") {
                    Some(window) if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) => {
                        let _ = window.hide();
                    }
                    _ => focus_main(app),
                }
            });

            // An unbundled dev binary borrows Terminal's notification identity.
            #[cfg(target_os = "macos")]
            if tauri::is_dev()
                && let Err(err) = mac_notification_sys::set_application("com.apple.Terminal")
            {
                log::warn!("set_application(Terminal) failed: {err}");
            }
            let handle = app.handle().clone();
            notifications::set_activation_handler(move |activation| match activation {
                Activation::Open(channel_id) if channel_id.is_empty() => focus_main(&handle),
                Activation::Open(channel_id) => navigate(&handle, &format!("/channels/{channel_id}")),
                Activation::Reply(reply) => {
                    let _ = handle.emit("desktop://reply", reply);
                }
            });

            #[cfg(target_os = "linux")]
            {
                // WebKitGTK can reset the title to the WRY default before the first paint.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&slug);
                }
                notifications::linux::init(slug);
            }
            Ok(())
        })
        // Closing hides the window, so the webview and the SSE stream behind notifications keep running.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(menu::handle_event)
        .invoke_handler(tauri::generate_handler![
            menu::set_recent_channels,
            tray::set_tray_unread,
            notifications::notify_channel_message,
            notifications::notify_debug_ping,
            #[cfg(target_os = "linux")]
            notifications::linux::notify_diagnostics,
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
