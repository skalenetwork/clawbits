//! Per-channel desktop notifications.
//!
//! Design: every incoming message gets its own fresh notification with
//! a unique identifier — that way macOS treats each delivery as a new
//! arrival (banner + sound) instead of as an "update to existing"
//! (silent, in-place mutation). On macOS we use `threadIdentifier` so
//! Notification Center still groups them per channel; on Linux we just
//! let the daemon stack them however it likes.
//!
//! Two macOS backends:
//!
//! - **Dev** (`tauri::is_dev()`): legacy NSUserNotification. The dev
//!   binary isn't bundled in a real .app, so the modern API can't
//!   request authorization properly. We swizzle the bundle identifier
//!   to `com.apple.Terminal` in `lib.rs` so NSUserNotification's
//!   delivery system has something to attribute to.
//!
//! - **Production** (bundled .app): `UNUserNotificationCenter`. The
//!   modern API supports `threadIdentifier` (per-channel sub-stacks in
//!   Notification Center), `interruptionLevel = .active` (re-banners
//!   each time), `UNNotificationSound`, and the lifetime stays
//!   maintained by Apple. Each request has a unique identifier (UUID)
//!   so banners fire for every message.

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

use serde::Deserialize;

// Tauri serializes JS payloads via serde_json with default field-name
// matching, so the Rust struct has to declare the camelCase shape the
// frontend sends. Without this the command silently returns a
// deserialization error and never runs.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub channel_id: String,
    pub channel_name: String,
    pub author_name: String,
    pub body: String,
}

/// Linux identity strings for GNOME Shell / KDE notification routing.
///
/// Two separate slots because tauri-bundler historically installed
/// these under inconsistent conventions inside the `.deb` — icons
/// derived from `mainBinaryName`, `.desktop` file derived from
/// `productName` (with spaces preserved). Today we keep `productName`
/// and `mainBinaryName` aligned to the same slug (see
/// `desktop/README.md` → "Channel naming convention"), so both names
/// always hold the same value — but the two-slot API is preserved as a
/// guard so a future `productName` divergence wouldn't silently
/// re-introduce the GNOME-drops-notifications bug.
///
/// Set once at startup; missing values fall back to safe defaults so
/// notifications still attempt to deliver if init order ever changes.
#[cfg(target_os = "linux")]
static ICON_NAME: OnceLock<String> = OnceLock::new();
#[cfg(target_os = "linux")]
static DESKTOP_ENTRY_NAME: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "linux")]
pub fn set_app_identity(icon_name: &str, desktop_entry: &str) {
    let _ = ICON_NAME.set(icon_name.to_string());
    let _ = DESKTOP_ENTRY_NAME.set(desktop_entry.to_string());
}

#[cfg(target_os = "linux")]
fn icon_name() -> &'static str {
    ICON_NAME.get().map(String::as_str).unwrap_or("clawbits")
}

#[cfg(target_os = "linux")]
fn desktop_entry_name() -> &'static str {
    DESKTOP_ENTRY_NAME
        .get()
        .map(String::as_str)
        .unwrap_or("clawbits")
}

#[cfg(target_os = "macos")]
pub fn deliver(message: &ChannelMessage) {
    if tauri::is_dev() {
        macos_legacy::deliver(message);
    } else {
        macos_modern::deliver(message);
    }
}

#[cfg(target_os = "linux")]
pub fn deliver(message: &ChannelMessage) {
    linux::deliver(message);
}

/// Linux-only: dump everything relevant to D-Bus notification routing
/// to the log at boot. Call once after `set_app_identity` so the icon
/// name and `DesktopEntry` we'll be sending are known. Call site in
/// `lib.rs` is gated on `target_os = "linux"`, so no stub is needed
/// elsewhere.
#[cfg(target_os = "linux")]
pub fn log_linux_environment(binary: &str, product_name: &str, identifier: &str) {
    linux::log_environment(binary, product_name, identifier);
}

/// Linux + AppImage only: ensure a user-level `.desktop` file exists so
/// GNOME Shell can match — and therefore display — our notifications. The
/// `.deb` installs one system-wide; the portable AppImage installs
/// nothing, so without this GNOME silently drops every notification we
/// send. No-op when the app wasn't launched from an AppImage (`.deb` /
/// `cargo tauri dev`). Call site in `lib.rs` is gated on `target_os =
/// "linux"`, so no stub is needed elsewhere.
#[cfg(target_os = "linux")]
pub fn ensure_appimage_desktop_integration() {
    linux::ensure_appimage_desktop_file();
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn deliver(_message: &ChannelMessage) {
    // Windows / unsupported — fall through.
}

/// Production-only: ask the user once for permission to post
/// notifications. Dev mode piggybacks on Terminal's permission via the
/// bundle-id swizzle and doesn't need this.
#[cfg(target_os = "macos")]
pub fn request_authorization_if_prod() {
    if !tauri::is_dev() {
        macos_modern::request_authorization();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_authorization_if_prod() {}

// =========================================================================
// macOS — legacy NSUserNotification (dev binaries)
// =========================================================================

#[cfg(target_os = "macos")]
mod macos_legacy {
    use super::ChannelMessage;
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::NSString;

    pub fn deliver(message: &ChannelMessage) {
        log::info!(
            "notify (NS): channel={} author={}",
            message.channel_id,
            message.author_name
        );

        // SAFETY: all selectors are documented NSUserNotification /
        // NSUserNotificationCenter API. No identifier set — each delivery
        // creates a fresh notification, so macOS banners every time.
        unsafe {
            let _mtm = match MainThreadMarker::new() {
                Some(m) => m,
                None => {
                    log::warn!("notify NS: not on main thread, skipping");
                    return;
                }
            };

            let ns_title = NSString::from_str(&message.channel_name);
            let ns_body = NSString::from_str(&message.body);

            let cls_notif = class!(NSUserNotification);
            let notif: Retained<AnyObject> = msg_send![cls_notif, new];

            let _: () = msg_send![&*notif, setTitle: &*ns_title];
            // For DMs the channel display name IS the other person's name,
            // so a separate author subtitle would just duplicate the title.
            if message.author_name != message.channel_name {
                let ns_subtitle = NSString::from_str(&message.author_name);
                let _: () = msg_send![&*notif, setSubtitle: &*ns_subtitle];
            }
            let _: () = msg_send![&*notif, setInformativeText: &*ns_body];
            let _: () = msg_send![&*notif, setHasActionButton: false];
            // NSUserNotificationDefaultSoundName is the literal string
            // "DefaultSoundName" (per Apple's NSUserNotification.h);
            // setting it tells AppKit to play the user's default
            // notification sound. Without this NS deliveries are silent.
            let ns_sound = NSString::from_str("DefaultSoundName");
            let _: () = msg_send![&*notif, setSoundName: &*ns_sound];

            let cls_center = class!(NSUserNotificationCenter);
            let center: Retained<AnyObject> =
                msg_send![cls_center, defaultUserNotificationCenter];
            let _: () = msg_send![&*center, deliverNotification: &*notif];
        }
    }
}

// =========================================================================
// macOS — modern UNUserNotificationCenter (production builds)
// =========================================================================

#[cfg(target_os = "macos")]
mod macos_modern {
    use super::ChannelMessage;
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::NSString;

    // Without an explicit link, dyld doesn't pull UserNotifications.framework
    // into the process even though we call into it via objc runtime, so
    // class!(UN*) finds stub classes whose method tables aren't populated.
    // Result: every msg_send is a silent no-op. Linking it forces the load.
    #[link(name = "UserNotifications", kind = "framework")]
    extern "C" {}

    // UNAuthorizationOptions bitflags. Constants from UserNotifications.h.
    const OPT_BADGE: u64 = 1 << 0;
    const OPT_SOUND: u64 = 1 << 1;
    const OPT_ALERT: u64 = 1 << 2;

    // UNNotificationInterruptionLevel. We want .active so each notification
    // banners (not .passive which is silent).
    const INTERRUPTION_ACTIVE: i64 = 1;

    pub fn request_authorization() {
        let options = OPT_ALERT | OPT_SOUND | OPT_BADGE;
        // SAFETY: documented UNUserNotificationCenter API. nil completion
        // handler is allowed per Apple's docs — the user's choice is
        // persisted in their notification settings regardless.
        unsafe {
            let cls_center = class!(UNUserNotificationCenter);
            let center: Retained<AnyObject> =
                msg_send![cls_center, currentNotificationCenter];
            log::info!("UN requestAuthorization: center={:p}", &*center);
            let nil_block: *const std::ffi::c_void = std::ptr::null();
            let _: () = msg_send![
                &*center,
                requestAuthorizationWithOptions: options,
                completionHandler: nil_block,
            ];
        }
    }

    pub fn deliver(message: &ChannelMessage) {
        log::info!(
            "notify (UN): channel={} author={}",
            message.channel_id,
            message.author_name
        );

        // SAFETY: documented UN* API. Each request has a unique UUID
        // identifier (so banners fire), threadIdentifier == channel id
        // (so Notification Center groups per channel), interruption
        // level .active (default banner behavior).
        unsafe {
            let ns_title = NSString::from_str(&message.channel_name);
            let ns_body = NSString::from_str(&message.body);
            let ns_thread = NSString::from_str(&message.channel_id);

            let cls_content = class!(UNMutableNotificationContent);
            let content: Retained<AnyObject> = msg_send![cls_content, new];
            let _: () = msg_send![&*content, setTitle: &*ns_title];
            // For DMs the channel display name IS the other person's name,
            // so a separate author subtitle would just duplicate the title.
            if message.author_name != message.channel_name {
                let ns_subtitle = NSString::from_str(&message.author_name);
                let _: () = msg_send![&*content, setSubtitle: &*ns_subtitle];
            }
            let _: () = msg_send![&*content, setBody: &*ns_body];
            let _: () = msg_send![&*content, setThreadIdentifier: &*ns_thread];
            let _: () = msg_send![&*content, setInterruptionLevel: INTERRUPTION_ACTIVE];

            let cls_sound = class!(UNNotificationSound);
            let sound: Retained<AnyObject> = msg_send![cls_sound, defaultSound];
            let _: () = msg_send![&*content, setSound: &*sound];

            // Unique identifier per delivery — UUID string from NSUUID.
            // The threadIdentifier handles grouping; the request id is
            // just a key Apple uses to look up the notification later
            // (for cancellation, etc.).
            let cls_uuid = class!(NSUUID);
            let uuid: Retained<AnyObject> = msg_send![cls_uuid, UUID];
            let uuid_str: Retained<NSString> = msg_send![&*uuid, UUIDString];

            let cls_request = class!(UNNotificationRequest);
            // trigger = nil → fires immediately.
            let nil_trigger: *const std::ffi::c_void = std::ptr::null();
            let request: Retained<AnyObject> = msg_send![
                cls_request,
                requestWithIdentifier: &*uuid_str,
                content: &*content,
                trigger: nil_trigger,
            ];

            let cls_center = class!(UNUserNotificationCenter);
            let center: Retained<AnyObject> =
                msg_send![cls_center, currentNotificationCenter];
            let nil_block: *const std::ffi::c_void = std::ptr::null();
            let _: () = msg_send![
                &*center,
                addNotificationRequest: &*request,
                withCompletionHandler: nil_block,
            ];
        }
    }
}

// =========================================================================
// Linux — notify-rust over D-Bus
// =========================================================================

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::sync::Once;

    use super::{desktop_entry_name, icon_name, ChannelMessage};

    /// Hint values are kept as module constants so the boot-time
    /// environment dump and the per-delivery log line both report the
    /// exact same strings the daemon actually sees.
    const URGENCY_LABEL: &str = "Normal";
    const CATEGORY: &str = "im.received";
    const SOUND_NAME: &str = "message-new-instant";
    const TIMEOUT_MS: u32 = 5_000;

    /// Probe the notification server once and dump its identity + capability
    /// list to the log. GNOME Shell, KDE Plasma, dunst, mako, xfce4-notifyd
    /// all report different combinations — this is the first place to look
    /// when "the dock counter flashes but nothing lands in the tray".
    static PROBE: Once = Once::new();
    fn log_server_probe_once() {
        PROBE.call_once(|| {
            match notify_rust::get_server_information() {
                Ok(info) => log::info!(
                    "notify server: name={} vendor={} version={} spec={}",
                    info.name, info.vendor, info.version, info.spec_version,
                ),
                Err(err) => log::warn!("notify server: get_server_information failed: {err}"),
            }
            match notify_rust::get_capabilities() {
                Ok(caps) => log::info!("notify caps: {:?}", caps),
                Err(err) => log::warn!("notify caps: get_capabilities failed: {err}"),
            }
        });
    }

    /// Candidate paths where the freedesktop `.desktop` file for this
    /// app might be installed. We probe every standard application
    /// directory for every plausible basename — `mainBinaryName`,
    /// `productName`, lower-case productName, and productName with
    /// underscores instead of spaces — because tauri-bundler picks
    /// the filename from `productName` (with spaces preserved) on .deb
    /// while icons are installed under `mainBinaryName`. Logging which
    /// candidates exist is the single most useful diagnostic when
    /// notifications are silently dropped.
    fn desktop_file_candidates(basenames: &[String]) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        dirs.push(PathBuf::from("/usr/share/applications"));
        dirs.push(PathBuf::from("/usr/local/share/applications"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(Path::new(&home).join(".local/share/applications"));
        }
        if let Ok(appdir) = std::env::var("APPDIR") {
            dirs.push(Path::new(&appdir).join("usr/share/applications"));
        }
        for entry in std::env::var("XDG_DATA_DIRS")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
        {
            dirs.push(Path::new(entry).join("applications"));
        }
        // Hardcoded dirs and XDG_DATA_DIRS typically overlap on
        // /usr/share/applications — dedupe so the per-basename probe
        // doesn't double-log every check.
        dirs.sort();
        dirs.dedup();

        let mut out = Vec::new();
        for dir in &dirs {
            for base in basenames {
                out.push(dir.join(format!("{base}.desktop")));
            }
        }
        out
    }

    /// Build the candidate basename list from the binary name and the
    /// productName. Dedupes case-preserving variants (productName,
    /// lowercased, spaces→underscores) so we catch whichever convention
    /// the bundler happened to use.
    fn candidate_basenames(binary: &str, product_name: &str) -> Vec<String> {
        let mut out: Vec<String> = vec![
            binary.to_string(),
            product_name.to_string(),
            product_name.to_lowercase(),
            product_name.replace(' ', "_"),
            product_name.replace(' ', "-"),
            product_name.replace(' ', ""),
        ];
        out.sort();
        out.dedup();
        out
    }

    fn which(program: &str) -> Option<String> {
        let path = std::env::var("PATH").ok()?;
        for dir in path.split(':').filter(|s| !s.is_empty()) {
            let candidate = Path::new(dir).join(program);
            if candidate.is_file() {
                return Some(candidate.display().to_string());
            }
        }
        None
    }

    pub fn log_environment(binary: &str, product_name: &str, identifier: &str) {
        log::info!("--- notification environment ---");
        log::info!(
            "binary={binary} product_name={product_name:?} identifier={identifier}"
        );
        log::info!(
            "hints we send: icon={:?} desktop_entry={:?}",
            icon_name(),
            desktop_entry_name(),
        );

        // Resolved executable path tells us whether we're installed at
        // /usr/bin (deb), unpacked into AppDir (AppImage), inside a
        // sandbox (snap/flatpak), or running uninstalled from a build
        // tree. Each has different .desktop registration semantics.
        match std::env::current_exe() {
            Ok(p) => log::info!("executable: {}", p.display()),
            Err(err) => log::warn!("executable: read failed: {err}"),
        }

        // Display server + desktop env. WM_DELETE_WINDOW, tray and
        // notification routing all behave differently per combination.
        for var in [
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_TYPE",
            "XDG_SESSION_DESKTOP",
            "DESKTOP_SESSION",
            "GDMSESSION",
            "XDG_DATA_HOME",
            "XDG_DATA_DIRS",
            "APPIMAGE",
            "APPDIR",
            "SNAP",
            "FLATPAK_ID",
            "container",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            match std::env::var(var) {
                Ok(v) => log::info!("env {var}={v}"),
                Err(_) => log::info!("env {var}=(unset)"),
            }
        }

        // The single highest-signal diagnostic: does an installed
        // .desktop file exist whose basename matches the hint we send?
        // We probe under every reasonable basename (binary, productName,
        // lower/underscore/hyphen variants) since the bundler picks one
        // convention and we want to surface mismatches in the log
        // directly rather than guessing.
        let basenames = candidate_basenames(binary, product_name);
        log::info!(".desktop candidate basenames: {:?}", basenames);
        let mut any_found = false;
        let mut hint_match_found = false;
        for path in desktop_file_candidates(&basenames) {
            let exists = path.exists();
            log::info!(
                ".desktop check: {} -> {}",
                path.display(),
                if exists { "FOUND" } else { "missing" }
            );
            if exists {
                any_found = true;
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem == desktop_entry_name() {
                        hint_match_found = true;
                    }
                }
            }
        }
        if !any_found {
            log::warn!(
                ".desktop file not found under any candidate basename — \
                 GNOME Shell will likely drop our notifications. \
                 Install the .deb (or invoke `update-desktop-database`) to register it."
            );
        } else if !hint_match_found {
            log::warn!(
                "found an installed .desktop file but none of them match \
                 our DesktopEntry hint = {:?}. GNOME will likely drop \
                 our notifications. Adjust set_app_identity to align.",
                desktop_entry_name(),
            );
        }

        // notify-send is the canonical shell-out fallback. If it's
        // missing the user's distro lacks libnotify-bin and our path
        // through notify-rust is the only option.
        match which("notify-send") {
            Some(p) => log::info!("notify-send: {p}"),
            None => log::warn!("notify-send: not found in PATH (libnotify-bin not installed)"),
        }

        // Reach out to the daemon now rather than waiting for the first
        // message — failures here mean D-Bus itself can't talk to the
        // notification server (no daemon running, sandbox blocks the
        // bus, etc.).
        log_server_probe_once();

        log::info!("--- end notification environment ---");
    }

    /// Build the freedesktop Notification with the hint set we've settled
    /// on after wrestling with GNOME 46. Split out so the debug-ping
    /// command can fire a minimal, hand-crafted payload through the same
    /// pipeline as the real delivery — that's the cleanest A/B test for
    /// "is the daemon dropping our payload or our connection?"
    fn base_notification<'a>(
        summary: &'a str,
        body: &'a str,
    ) -> notify_rust::Notification {
        // Why each hint matters on GNOME Shell 46:
        //
        // * `DesktopEntry` MUST exactly match the installed `.desktop`
        //   file's basename (no extension). Tauri's .deb bundler derives
        //   this from `productName`. Since we now align `productName`
        //   with `mainBinaryName` to a single slug (e.g.
        //   `clawbits-staging`), the hint and the installed filename
        //   match by construction. Mismatch = Shell silently drops the
        //   notification, which is the regression we hit in 0.2.1/0.2.2.
        //   Sourced from `desktop_entry_name()`.
        //
        // * `icon` is a separate lookup against the hicolor icon theme,
        //   keyed by `mainBinaryName` because that's the filename the
        //   bundler installs under `/usr/share/icons/hicolor/<size>/apps/`.
        //   Sourced from `icon_name()` rather than reusing the
        //   DesktopEntry hint so the two-slot guard stays meaningful if
        //   the names ever diverge again.
        //
        // * `Urgency::Normal` — explicit so we don't depend on daemon
        //   defaults. Critical would also work but keeps the banner up
        //   indefinitely; chat pings are normal.
        //
        // * `Category("im.received")` — freedesktop standard for incoming
        //   chat messages; tells daemons that route by category (KDE) to
        //   pick the right rule set, and is harmless on others.
        //
        // * NO `appname()` — we used to set it to the same string as
        //   `DesktopEntry`, but GNOME Shell treats `appname` as
        //   authoritative when both are set, and it doesn't match its
        //   notification-source registry the same way `DesktopEntry` does.
        //   Dropping appname lets `DesktopEntry` win cleanly.
        //
        // * `timeout(5_000)` — explicit lifetime instead of "server
        //   default". Some daemons interpret a missing timeout as
        //   "transient" (don't persist in tray) so being explicit is
        //   defensive.
        let mut n = notify_rust::Notification::new();
        n.summary(summary)
            .body(body)
            .icon(icon_name())
            .hint(notify_rust::Hint::DesktopEntry(desktop_entry_name().into()))
            .hint(notify_rust::Hint::Category(CATEGORY.into()))
            .hint(notify_rust::Hint::Urgency(notify_rust::Urgency::Normal))
            .hint(notify_rust::Hint::SoundName(SOUND_NAME.into()))
            .timeout(notify_rust::Timeout::Milliseconds(TIMEOUT_MS));
        n
    }

    /// Log the exact payload we're about to hand to `org.freedesktop.
    /// Notifications.Notify`. One line per delivery so a `grep "notify
    /// send:"` over the log file shows every attempt with its full
    /// hint set — what the daemon actually receives.
    fn log_payload(summary: &str, body: &str, kind: &str, extra: &str) {
        log::info!(
            "notify send ({kind}): {extra}desktop_entry={:?} icon={:?} category={:?} urgency={} sound={:?} timeout_ms={} summary={:?} body={:?}",
            desktop_entry_name(),
            icon_name(),
            CATEGORY,
            URGENCY_LABEL,
            SOUND_NAME,
            TIMEOUT_MS,
            summary,
            body,
        );
    }

    pub fn deliver(message: &ChannelMessage) {
        log_server_probe_once();
        // Body folds the author in since Linux notifications have no
        // subtitle slot. For DMs (where the channel name IS the author)
        // we'd otherwise read "Dmytro Tkachuk: msg" with "Dmytro Tkachuk"
        // already in the title — skip the prefix in that case.
        let body = if message.author_name == message.channel_name {
            message.body.clone()
        } else {
            format!("{}: {}", message.author_name, message.body)
        };
        let extra = format!(
            "channel_id={:?} channel_name={:?} author={:?} ",
            message.channel_id, message.channel_name, message.author_name,
        );
        log_payload(&message.channel_name, &body, "message", &extra);
        match base_notification(&message.channel_name, &body).show() {
            Ok(handle) => log::info!(
                "notify result (message): OK id={} channel_id={:?}",
                handle.id(),
                message.channel_id,
            ),
            Err(err) => log::error!(
                "notify result (message): ERR channel_id={:?} err={err:#}",
                message.channel_id,
            ),
        }
    }

    /// One-shot debug ping. Lets the user trigger a hand-crafted test
    /// notification from DevTools (`invoke('notify_debug_ping')`) without
    /// needing a real incoming chat message. The payload is intentionally
    /// minimal and all-ASCII so we can rule out malformed body content.
    pub fn debug_ping() {
        log_server_probe_once();
        let summary = "Clawbits debug ping";
        let body = "If you see this, the daemon is wired up.";
        log_payload(summary, body, "debug-ping", "");
        match base_notification(summary, body).show() {
            Ok(handle) => log::info!("notify result (debug-ping): OK id={}", handle.id()),
            Err(err) => log::error!("notify result (debug-ping): ERR err={err:#}"),
        }
    }

    /// Write `~/.local/share/applications/<slug>.desktop` for AppImage
    /// runs so GNOME Shell can attribute — and therefore display — our
    /// notifications. The file's basename, `Name`, and `StartupWMClass`
    /// all equal the slug, which is exactly the `desktop-entry` hint
    /// `base_notification` sends, satisfying GNOME's match rule. As a
    /// bonus the `MimeType` line registers the deep-link scheme so
    /// `clawbits://` URLs route to the AppImage too.
    ///
    /// Idempotent: rewrites only when the file is missing or its `Exec`
    /// no longer points at the current AppImage (it moved or
    /// auto-updated). No-op when `APPIMAGE` is unset (`.deb` / dev run).
    pub fn ensure_appimage_desktop_file() {
        // The AppImage runtime exports APPIMAGE (absolute path to the
        // .AppImage) and APPDIR (mounted squashfs root). Both are absent
        // on .deb installs and `cargo tauri dev`, so this whole routine
        // is a no-op there.
        let appimage = match std::env::var("APPIMAGE") {
            Ok(p) if !p.is_empty() => p,
            _ => {
                log::info!("appimage integration: APPIMAGE unset — skipping (.deb or dev run)");
                return;
            }
        };
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => h,
            _ => {
                log::warn!("appimage integration: HOME unset — cannot install .desktop");
                return;
            }
        };

        let slug = desktop_entry_name();
        let apps_dir = Path::new(&home).join(".local/share/applications");
        let target = apps_dir.join(format!("{slug}.desktop"));
        let exec_line = format!("Exec={appimage} %u");

        let contents = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Version=1.0\n\
             Name={slug}\n\
             GenericName=AI Agent Messaging\n\
             Comment=Cloud sharing hub for AI agents\n\
             {exec_line}\n\
             Icon={slug}\n\
             Terminal=false\n\
             Categories=Network;InstantMessaging;\n\
             Keywords=chat;messaging;agents;ai;bots;clawbits;\n\
             StartupNotify=true\n\
             StartupWMClass={slug}\n\
             MimeType=x-scheme-handler/{slug};\n\
             X-GNOME-UsesNotifications=true\n"
        );

        // Skip the disk write + update-desktop-database shell-out when the
        // installed file already targets this exact AppImage path.
        if let Ok(existing) = std::fs::read_to_string(&target) {
            if existing.contains(&exec_line) {
                log::info!("appimage integration: {} already current", target.display());
                return;
            }
        }

        if let Err(err) = std::fs::create_dir_all(&apps_dir) {
            log::warn!("appimage integration: mkdir {} failed: {err}", apps_dir.display());
            return;
        }
        if let Err(err) = std::fs::write(&target, &contents) {
            log::warn!("appimage integration: write {} failed: {err}", target.display());
            return;
        }
        log::info!("appimage integration: wrote {}", target.display());

        // Cosmetic: surface the bundled icon in the notification + app
        // drawer. Notifications display regardless once the basename
        // matches, so a failure here is non-fatal.
        install_appimage_icon(&home, slug);

        // Make GNOME Shell pick up the new file without a re-login.
        match std::process::Command::new("update-desktop-database")
            .arg(&apps_dir)
            .status()
        {
            Ok(status) => {
                log::info!("appimage integration: update-desktop-database exit={status}")
            }
            Err(err) => log::info!(
                "appimage integration: update-desktop-database unavailable ({err}) \
                 — GNOME may need a re-login to see the new .desktop"
            ),
        }
    }

    /// Best-effort copy of the AppImage's bundled icon into the user's
    /// hicolor theme so `Icon={slug}` resolves to artwork. Tries the
    /// handful of places AppImages stash their icon and silently gives up
    /// otherwise — purely cosmetic.
    fn install_appimage_icon(home: &str, slug: &str) {
        let appdir = match std::env::var("APPDIR") {
            Ok(d) if !d.is_empty() => d,
            _ => return,
        };
        let candidates = [
            Path::new(&appdir).join(format!("usr/share/icons/hicolor/256x256/apps/{slug}.png")),
            Path::new(&appdir).join(format!("{slug}.png")),
            Path::new(&appdir).join(".DirIcon"),
        ];
        let Some(src) = candidates.into_iter().find(|p| p.is_file()) else {
            log::info!("appimage integration: no bundled icon found to install");
            return;
        };
        let dest_dir = Path::new(home).join(".local/share/icons/hicolor/256x256/apps");
        let dest = dest_dir.join(format!("{slug}.png"));
        if dest.is_file() {
            return;
        }
        if let Err(err) = std::fs::create_dir_all(&dest_dir) {
            log::info!("appimage integration: icon mkdir failed: {err}");
            return;
        }
        match std::fs::copy(&src, &dest) {
            Ok(_) => {
                log::info!(
                    "appimage integration: installed icon {} -> {}",
                    src.display(),
                    dest.display()
                )
            }
            Err(err) => log::info!("appimage integration: icon copy failed: {err}"),
        }
    }
}

/// Trigger a hand-crafted debug notification. Linux-only path is wired
/// up; on macOS and Windows it logs and returns so the JS caller doesn't
/// crash if a developer invokes it on the wrong platform.
pub fn debug_ping() {
    #[cfg(target_os = "linux")]
    linux::debug_ping();
    #[cfg(not(target_os = "linux"))]
    log::info!("notify debug_ping called on non-Linux platform — no-op");
}
