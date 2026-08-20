use std::sync::Mutex;

use tauri::{Manager, WindowEvent};

mod dock;
mod menu;
mod notifications;
mod shortcuts;
mod tray;

/// URL prefixes the deep-link plumbing should recognize. The base scheme
/// is `clawbits`; channel-specific builds (Staging, Dev) use suffixed
/// schemes so a prod, staging, and dev install can coexist on one
/// machine without fighting over `xdg-mime` / Launch Services routing.
/// The full set is matched at runtime — each binary registers only its
/// own scheme via `plugins.deep-link.desktop.schemes` in the config
/// overlay, but the recognizer is kept channel-agnostic so we don't
/// have to thread the value through compile-time features.
const KNOWN_DEEP_LINK_PREFIXES: &[&str] = &[
    "clawbits://",
    "clawbits-staging://",
    "clawbits-dev://",
];

fn is_deep_link_url(s: &str) -> bool {
    KNOWN_DEEP_LINK_PREFIXES.iter().any(|p| s.starts_with(p))
}


/// Set the webview's zoom factor. The frontend persists its preferred
/// level in localStorage and replays it here on boot; menu items for
/// "Zoom In/Out/Actual Size" emit `desktop://zoom` events that the
/// frontend translates into calls to this command.
#[tauri::command]
fn set_zoom(app: tauri::AppHandle, scale: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not found".into());
    };
    window
        .set_zoom(scale.clamp(0.5, 3.0))
        .map_err(|e| e.to_string())
}

/// Replace the contents of the Window → Recent submenu. Called by the
/// frontend whenever the user's recent-channels list changes (channel
/// page mount, or hydration on app boot).
#[tauri::command]
fn set_recent_channels(
    items: Vec<menu::RecentChannel>,
    state: tauri::State<'_, menu::RecentState<tauri::Wry>>,
) -> Result<(), String> {
    let slots = state.slots.lock().map_err(|e| e.to_string())?;
    for (i, slot) in slots.iter().enumerate() {
        if let Some(item) = items.get(i) {
            slot.set_text(&item.name).map_err(|e| e.to_string())?;
            slot.set_enabled(true).map_err(|e| e.to_string())?;
        } else {
            slot.set_text("—").map_err(|e| e.to_string())?;
            slot.set_enabled(false).map_err(|e| e.to_string())?;
        }
    }
    *state.items.lock().map_err(|e| e.to_string())? = items;
    Ok(())
}

/// Post a notification for a new channel message. macOS banners every message
/// and groups them per channel via `threadIdentifier`; Linux replaces the
/// channel's previous banner in place.
///
/// `async` is load-bearing, not stylistic. Tauri executes non-async commands
/// **on the main thread**, and the Linux path used to make a blocking D-Bus
/// call from here — one that can wait out the 25s service-activation timeout
/// when no notification daemon is running, freezing the window for that long.
/// Delivery is now queued onto a notifier thread, and `async` keeps this
/// handler off the UI thread regardless.
#[tauri::command(async)]
fn notify_channel_message(
    app: tauri::AppHandle,
    message: notifications::ChannelMessage,
) -> Result<(), String> {
    // NSUserNotification (dev) requires main-thread dispatch, so macOS keeps
    // it. Linux must NOT go anywhere near the main thread — see above.
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            notifications::deliver(&message);
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        notifications::deliver(&message);
        Ok(())
    }
}

/// Fire a test notification through the same delivery path as real messages.
/// Backs the "Send a test notification" button in Settings → Notifications;
/// isolates "the daemon dropped our payload" from "the app never sent one".
#[tauri::command(async)]
fn notify_debug_ping(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(notifications::debug_ping)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        notifications::debug_ping();
        Ok(())
    }
}

/// What this machine can tell us about notification delivery — daemon
/// identity, capabilities, and whether an installed `.desktop` file matches
/// the hint we send. Backs the diagnostics panel in Settings → Notifications.
///
/// On Linux this waits on the notifier thread, so it runs via `spawn_blocking`
/// rather than occupying an async worker for the duration.
#[tauri::command]
async fn notify_diagnostics() -> Result<notifications::Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(notifications::diagnostics)
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Single-instance must come first so secondary launches funnel into
        // the running window — including launches triggered by clawbits://
        // deep links arriving from the system browser after OAuth.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // When the second instance was launched via a clawbits:// URL
            // (or the channel-specific clawbits-staging:// / clawbits-dev://
            // variants), argv contains the URL — forward it to JS via the
            // same event the deep-link plugin uses for already-running
            // deliveries. The JS event name stays uniform across channels
            // so the frontend listener doesn't need a per-build constant.
            for arg in argv {
                if is_deep_link_url(&arg) {
                    let _ = app.emit("clawbits://deep-link", arg);
                }
            }
        }));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::default()
                // Info in release too — volume is tiny and we need this
                // detail to diagnose Linux notification issues on user
                // machines where stdout isn't visible.
                .level(log::LevelFilter::Info)
                .targets([
                    // Stdout — visible when the user launches from a
                    // terminal (`clawbits-staging` from a shell).
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // Persistent log file. Fixed filename across channels
                    // so the path is stable per identifier:
                    //   Linux:   ~/.local/share/<bundle-id>/logs/clawbits.log
                    //   macOS:   ~/Library/Logs/<bundle-id>/clawbits.log
                    //   Windows: %APPDATA%/<bundle-id>/logs/clawbits.log
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("clawbits".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Window-state plugin restores size/position/maximized state on
        // launch and persists changes silently. No JS needed.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // LaunchAgent (vs LoginItem) is the modern macOS path and works
        // without elevated permissions; the second arg is the args list
        // passed to the binary on auto-launch — none for now.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    shortcuts::handle(app, shortcut, event.state());
                })
                .build(),
        )
        .setup(|app| {
            // Boot banner — first line of every session. Makes it trivial
            // to find the start of "this run" in a log file that
            // accumulates across launches.
            log::info!(
                "=== clawbits boot: v{} identifier={} binary={} ===",
                env!("CARGO_PKG_VERSION"),
                app.config().identifier,
                app.config()
                    .main_binary_name
                    .as_deref()
                    .unwrap_or("(unset)"),
            );
            if let Ok(log_dir) = app.path().app_log_dir() {
                log::info!("log directory: {}", log_dir.display());
            }

            // Forward deep-link URL events to the frontend. Listens for both
            // cold-start (initial URLs from OS launch) and warm hand-off
            // (URLs arriving while the app is already running).
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = app_handle.emit("clawbits://deep-link", url.to_string());
                    }
                });
            }

            // System tray icon (menu bar on macOS).
            tray::build(app.handle())?;

            // Register the toggle-window global shortcut. Errors are
            // tolerated — another app may have taken the binding.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app
                    .global_shortcut()
                    .register(shortcuts::toggle_window_shortcut());
            }

            let (built_menu, recent_slots, autostart_check) = menu::build(app.handle())?;
            app.set_menu(built_menu)?;

            // Sync the Launch-at-Login checkbox with the OS-level autostart
            // state on every launch so the menu reflects reality, even if
            // the user disabled it externally.
            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = autostart_check.set_checked(enabled);
            }

            // Park the menu handles in shared state so command handlers
            // can mutate labels / checked state without rebuilding.
            app.manage(menu::RecentState::<tauri::Wry> {
                items: Mutex::new(Vec::new()),
                slots: Mutex::new(recent_slots),
            });
            app.manage(menu::AutostartMenuItem::<tauri::Wry>(Mutex::new(Some(
                autostart_check,
            ))));
            // Dev binaries aren't bundled in a real .app, so NSUserNotification
            // can't attribute deliveries to "Clawbits" — swizzle the bundle
            // identifier to Terminal's so notifications appear under
            // Terminal's permission. Production builds are bundled and use
            // the modern UN* API directly, no swizzle needed.
            #[cfg(target_os = "macos")]
            if tauri::is_dev() {
                if let Err(err) = mac_notification_sys::set_application("com.apple.Terminal") {
                    log::warn!("set_application(Terminal) failed: {err}");
                }
            }

            // UN* permission prompt — shown once on first launch of a
            // production bundle. Stored in the user's notification
            // settings thereafter. No-op in dev.
            notifications::request_authorization_if_prod();

            // Close-to-background: red-X / Cmd-W / the dock's right-click
            // "Quit" hide the window instead of destroying it, so the
            // webview JS — and the SSE stream that feeds desktop
            // notifications — keeps running while the app sits in the
            // background. This is wired on every desktop, including
            // tray-less GNOME, which is what makes notifications keep
            // arriving after the window is closed on Ubuntu.
            //
            // Bringing the window back: the tray's Show (where a tray is
            // rendered — incl. Ubuntu's default GNOME), the Ctrl+Shift+C
            // global shortcut, GNOME's Background Apps menu (24.04+), or
            // relaunch (single-instance focuses the running window).
            //
            // Truly exiting: the tray's Quit, the app menu's Quit
            // (Cmd/Ctrl+Q), or GNOME's Background Apps → Quit — all call
            // `app.exit()` directly and bypass this CloseRequested handler.
            // (The dock's "Quit" sends the same WM_DELETE_WINDOW as the X
            // button, so it now hides rather than exits.)
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(window) = app.get_webview_window("main") {
                    // 4th arg = corner radius for the vibrancy backdrop. Left
                    // None so the backdrop defers to macOS's own window mask.
                    // We previously rounded it to 18px (with a matching CSS
                    // body clip) to soften the corners, but a custom radius
                    // that doesn't match the system mask leaves a dark seam
                    // tracing the corner — the window backing showing through
                    // the sliver between the two arcs. With None there's a
                    // single radius (the system's) and no seam.
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        None,
                    );
                }
            }

            // GTK title fix: WebKitGTK occasionally resets the toplevel
            // title to the WRY default ("Tauri App") between config-load
            // and the first paint, so the user briefly — or persistently
            // on some sessions — sees the wrong text in the title bar
            // and Activities. Re-apply from `mainBinaryName` (the
            // channel slug, e.g. `clawbits` / `clawbits-staging` /
            // `clawbits-dev`) after setup is otherwise complete.
            //
            // Same block also seeds the notification `desktop-entry` hint
            // from `mainBinaryName` so D-Bus notifications get attributed
            // to the right `.desktop` file across channels.
            #[cfg(target_os = "linux")]
            {
                let binary = app
                    .config()
                    .main_binary_name
                    .clone()
                    .unwrap_or_else(|| "clawbits".to_string());
                // After unifying naming to the slug form across all
                // channels, productName, mainBinaryName, the .desktop
                // basename, and the GNOME notification slug all coincide.
                // Window title, icon hint, and DesktopEntry hint can all
                // use the same single token.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&binary);
                }
                let product_name = app
                    .config()
                    .product_name
                    .clone()
                    .unwrap_or_else(|| binary.clone());
                notifications::set_app_identity(&binary, &product_name);
                // Clicking a notification should land the user in the channel
                // it came from, the same as the web build's service worker
                // does. The handler runs on the watcher thread that the D-Bus
                // signal wakes, so the window calls are bounced back onto the
                // main thread; emitting the event is thread-safe either way.
                {
                    use tauri::Emitter;
                    let handle = app.handle().clone();
                    notifications::set_activation_handler(move |channel_id| {
                        let _ = handle.emit("clawbits://notification-activated", channel_id);
                        let window_handle = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if let Some(window) = window_handle.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        });
                    });
                }
                // AppImage runs install nothing system-wide, so GNOME has
                // no `.desktop` to match our notifications' `desktop-entry`
                // hint against and silently drops them. Write a user-level
                // one on first launch. No-op for `.deb` installs (which
                // ship their own) and `cargo tauri dev`.
                notifications::ensure_appimage_desktop_integration();
                // Dump everything that affects D-Bus notification routing
                // on GNOME / KDE / etc. — desktop env, session type,
                // .desktop file presence, notify-send availability,
                // notification daemon identity and capabilities. Runs
                // once at boot and lives at the top of the log file so
                // it's the first thing to consult when a user reports
                // "notifications don't work".
                notifications::log_linux_environment(
                    &binary,
                    &product_name,
                    &app.config().identifier,
                );
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
        .run(|_app_handle, _event| {
            // macOS dock-icon reopen. The CloseRequested handler above hides
            // (not destroys) the window, so after the user closes it the app
            // lives on in the dock and tray. Clicking the dock icon then fires
            // `Reopen` with `has_visible_windows: false` — and because there
            // are no visible windows, AppKit can't bring anything forward on
            // its own. We re-show and focus the main window ourselves; without
            // this the dock icon is a dead click and the only way back is the
            // tray's Show or the Ctrl+Shift+C global shortcut.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    if let Some(window) = _app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}
