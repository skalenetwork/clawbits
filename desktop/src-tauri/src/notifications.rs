//! Per-channel desktop notifications.
//!
//! Design differs per platform because the two systems coalesce differently.
//! On macOS every delivery is a fresh notification with a unique identifier —
//! that way the OS treats it as a new arrival (banner + sound) rather than an
//! "update to existing" (silent, in-place mutation) — and `threadIdentifier`
//! groups them per channel in Notification Center. On Linux there is no such
//! grouping, so each channel instead reuses its previous notification id via
//! `replaces_id`: the newest message supersedes the last banner from that
//! channel, matching what the web build gets from a per-channel push `tag`.
//!
//! Linux delivery is never inline. A dedicated notifier thread owns every
//! D-Bus call, because those calls block and Tauri runs non-async commands on
//! the main thread. See the `linux` module for why that mattered.
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

use serde::{Deserialize, Serialize};

/// What this machine can actually tell us about notification delivery.
///
/// Everything here was already gathered at boot and written to the log file,
/// where only someone who knows to look for it ever saw it. Returning it to
/// the frontend is what turns "notifications don't work" into a report that
/// names the daemon and says whether GNOME has a `.desktop` file to attribute
/// us to. Linux fills every field; macOS has no equivalent surface (the OS
/// owns permission state) and reports only that it is supported.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    /// `"linux"` | `"macos"` | `"other"`.
    pub platform: String,
    /// False on platforms with no native backend compiled in (Windows today).
    pub supported: bool,
    /// Notification daemon identity — GNOME Shell, Plasma, dunst, mako, …
    pub server_name: Option<String>,
    pub server_vendor: Option<String>,
    /// Daemon capability list, verbatim from `org.freedesktop.Notifications`.
    pub capabilities: Vec<String>,
    /// The `DesktopEntry` hint we send, and the installed `.desktop` file
    /// whose basename matches it. A `None` file with a `Some` hint is the
    /// single highest-signal failure: GNOME has nothing to attribute us to
    /// and drops every notification silently.
    pub desktop_entry: Option<String>,
    pub desktop_file: Option<String>,
    /// Path to `notify-send`, when libnotify-bin is installed.
    pub notify_send: Option<String>,
    /// Set when the daemon could not be reached at all.
    pub error: Option<String>,
}

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

/// Linux delivery never happens inline. Every D-Bus call this module makes is
/// a blocking round trip, and D-Bus will try to *service-activate* a
/// notification daemon that isn't running — a wait bounded only by the 25s
/// activation timeout. Tauri runs non-async commands on the main thread, so an
/// inline call froze the UI for as long as the daemon took to answer. Handing
/// the message to the notifier thread returns immediately.
#[cfg(target_os = "linux")]
pub fn deliver(message: &ChannelMessage) {
    linux::enqueue(linux::Job::Message(message.clone()));
}

/// Linux-only: dump everything relevant to D-Bus notification routing
/// to the log at boot. Call once after `set_app_identity` so the icon
/// name and `DesktopEntry` we'll be sending are known. Call site in
/// `lib.rs` is gated on `target_os = "linux"`, so no stub is needed
/// elsewhere.
///
/// Queued rather than run inline: the dump probes the daemon over D-Bus, and
/// doing that from `setup()` blocked the window from appearing at all on a
/// machine with no daemon running.
#[cfg(target_os = "linux")]
pub fn log_linux_environment(binary: &str, product_name: &str, identifier: &str) {
    linux::enqueue(linux::Job::LogEnvironment {
        binary: binary.to_string(),
        product_name: product_name.to_string(),
        identifier: identifier.to_string(),
    });
}

/// Linux + AppImage only: ensure a user-level `.desktop` file exists so
/// GNOME Shell can match — and therefore display — our notifications. The
/// `.deb` installs one system-wide; the portable AppImage installs
/// nothing, so without this GNOME silently drops every notification we
/// send. No-op when the app wasn't launched from an AppImage (`.deb` /
/// `cargo tauri dev`). Call site in `lib.rs` is gated on `target_os =
/// "linux"`, so no stub is needed elsewhere.
///
/// Also queued — it shells out to `update-desktop-database`, and the notifier
/// thread is FIFO, so this still lands before the first message notification.
#[cfg(target_os = "linux")]
pub fn ensure_appimage_desktop_integration() {
    linux::enqueue(linux::Job::AppImageIntegration);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn deliver(_message: &ChannelMessage) {
    // Windows / unsupported — fall through.
}

/// Report what this machine can tell us about notification delivery. Backs the
/// diagnostics panel in Settings → Notifications.
#[cfg(target_os = "macos")]
pub fn diagnostics() -> Diagnostics {
    // macOS keeps permission state in System Settings and exposes it only
    // through an async completion handler; there is nothing honest to report
    // here beyond "the backend exists", so we don't invent a field.
    Diagnostics {
        platform: "macos".to_string(),
        supported: true,
        ..Default::default()
    }
}

#[cfg(target_os = "linux")]
pub fn diagnostics() -> Diagnostics {
    linux::diagnostics()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn diagnostics() -> Diagnostics {
    Diagnostics {
        platform: "other".to_string(),
        supported: false,
        ..Default::default()
    }
}

/// Install the callback invoked when the user clicks one of our notifications,
/// with the channel id it was posted for. Call once at startup.
///
/// Linux only, and cfg-gated rather than stubbed so the compiler keeps saying
/// so: routing a click needs the daemon's `actions` capability and a thread
/// waiting on the D-Bus signal. The macOS equivalent is a
/// `UNUserNotificationCenterDelegate` and is not wired up — clicking there
/// still activates the app, it just doesn't land on the channel.
#[cfg(target_os = "linux")]
pub fn set_activation_handler<F>(handler: F)
where
    F: Fn(&str) + Send + Sync + 'static,
{
    linux::set_activation_handler(Box::new(handler));
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
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use super::{desktop_entry_name, icon_name, ChannelMessage, Diagnostics};

    /// Hint values are kept as module constants so the boot-time
    /// environment dump and the per-delivery log line both report the
    /// exact same strings the daemon actually sees.
    /// freedesktop reserves the action key `default` for "the user clicked the
    /// notification body". Daemons render no button for it, which is exactly
    /// what we want — a chat banner should open on click, not grow an Open
    /// button.
    const DEFAULT_ACTION: &str = "default";
    const URGENCY_LABEL: &str = "Normal";
    const CATEGORY: &str = "im.received";
    const SOUND_NAME: &str = "message-new-instant";
    const TIMEOUT_MS: u32 = 5_000;

    /// Cached identity + capability list of the notification daemon. GNOME
    /// Shell, KDE Plasma, dunst, mako and xfce4-notifyd all report different
    /// combinations — this is the first place to look when "the dock counter
    /// flashes but nothing lands in the tray".
    ///
    /// Both probes are blocking D-Bus round trips, so this is initialised
    /// **only from the notifier thread**. Every caller below is already on it.
    #[derive(Default)]
    struct Probe {
        server: Option<ServerInfo>,
        caps: Vec<String>,
        error: Option<String>,
    }

    struct ServerInfo {
        name: String,
        vendor: String,
    }

    static PROBE: OnceLock<Probe> = OnceLock::new();

    fn probe() -> &'static Probe {
        PROBE.get_or_init(|| {
            let mut out = Probe::default();
            match notify_rust::get_server_information() {
                Ok(info) => {
                    log::info!(
                        "notify server: name={} vendor={} version={} spec={}",
                        info.name,
                        info.vendor,
                        info.version,
                        info.spec_version,
                    );
                    out.server = Some(ServerInfo {
                        name: info.name,
                        vendor: info.vendor,
                    });
                }
                Err(err) => {
                    log::warn!("notify server: get_server_information failed: {err}");
                    out.error = Some(err.to_string());
                }
            }
            match notify_rust::get_capabilities() {
                Ok(caps) => {
                    log::info!("notify caps: {:?}", caps);
                    out.caps = caps;
                }
                Err(err) => {
                    log::warn!("notify caps: get_capabilities failed: {err}");
                    out.error.get_or_insert_with(|| err.to_string());
                }
            }
            out
        })
    }

    // ---------------------------------------------------------------------
    // The notifier thread
    // ---------------------------------------------------------------------
    //
    // One long-lived thread owns every D-Bus call this module makes. Two
    // reasons it is a thread and not just an async command:
    //
    //   1. Nothing here may touch the UI thread. `Notification::show()` blocks
    //      until the daemon answers, and when no daemon is running D-Bus tries
    //      to service-activate one — a wait bounded only by the 25s activation
    //      timeout. Tauri runs non-async commands on the main thread, so that
    //      wait used to freeze the whole window.
    //
    //   2. Deliveries must serialise. A burst of messages arriving while the
    //      daemon is slow would otherwise pile up concurrent blocking calls,
    //      and the `replaces_id` bookkeeping below assumes a single writer.
    //
    // FIFO ordering is load-bearing: the AppImage `.desktop` integration is
    // queued from `setup()` and has to land before the first message, or GNOME
    // has nothing to attribute that message to.

    pub enum Job {
        Message(ChannelMessage),
        Ping,
        LogEnvironment {
            binary: String,
            product_name: String,
            identifier: String,
        },
        AppImageIntegration,
        /// Reply channel for the Settings diagnostics panel. Answered on this
        /// thread so it observes the same probe cache the real sends use.
        Diagnostics(Sender<Diagnostics>),
    }

    static QUEUE: OnceLock<Sender<Job>> = OnceLock::new();

    fn queue() -> &'static Sender<Job> {
        QUEUE.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            let spawned = std::thread::Builder::new()
                .name("clawbits-notify".to_string())
                .spawn(move || {
                    // Ends when the sender is dropped, which only happens at
                    // process exit — the sender lives in a static.
                    for job in rx {
                        match job {
                            Job::Message(message) => deliver_now(&message),
                            Job::Ping => ping_now(),
                            Job::LogEnvironment {
                                binary,
                                product_name,
                                identifier,
                            } => log_environment_now(&binary, &product_name, &identifier),
                            Job::AppImageIntegration => ensure_appimage_desktop_file(),
                            Job::Diagnostics(reply) => {
                                let _ = reply.send(collect_diagnostics());
                            }
                        }
                    }
                });
            if let Err(err) = &spawned {
                log::error!("notify: could not spawn notifier thread: {err}");
            }
            tx
        })
    }

    pub fn enqueue(job: Job) {
        if queue().send(job).is_err() {
            log::error!("notify: notifier thread is gone — dropping job");
        }
    }

    /// Ask the notifier thread for a diagnostics snapshot.
    ///
    /// Blocks the caller, so the command wrapping this must be off the UI
    /// thread. The timeout is generous on purpose: the answer is worth waiting
    /// for precisely when the daemon is being slow, which is the case a user
    /// opens this panel to investigate.
    pub fn diagnostics() -> Diagnostics {
        let (tx, rx) = channel::<Diagnostics>();
        enqueue(Job::Diagnostics(tx));
        rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| {
            log::warn!("notify diagnostics: notifier thread did not answer in time");
            Diagnostics {
                platform: "linux".to_string(),
                supported: true,
                desktop_entry: Some(desktop_entry_name().to_string()),
                error: Some(
                    "The notification daemon did not respond. It may not be running."
                        .to_string(),
                ),
                ..Default::default()
            }
        })
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

    /// The installed `.desktop` file whose basename equals the `DesktopEntry`
    /// hint we send — the one GNOME Shell actually matches on. `None` means
    /// the Shell has nothing to attribute us to and will drop our
    /// notifications, which is the single highest-signal failure on Linux.
    fn matching_desktop_file() -> Option<PathBuf> {
        let basenames = candidate_basenames(icon_name(), desktop_entry_name());
        desktop_file_candidates(&basenames)
            .into_iter()
            .find(|path| {
                path.exists()
                    && path.file_stem().and_then(|s| s.to_str()) == Some(desktop_entry_name())
            })
    }

    /// Snapshot for the Settings diagnostics panel. Runs on the notifier
    /// thread; `probe()` may block here, which is exactly why it does.
    pub fn collect_diagnostics() -> Diagnostics {
        let probed = probe();
        Diagnostics {
            platform: "linux".to_string(),
            supported: true,
            server_name: probed.server.as_ref().map(|s| s.name.clone()),
            server_vendor: probed.server.as_ref().map(|s| s.vendor.clone()),
            capabilities: probed.caps.clone(),
            desktop_entry: Some(desktop_entry_name().to_string()),
            desktop_file: matching_desktop_file().map(|p| p.display().to_string()),
            notify_send: which("notify-send"),
            error: probed.error.clone(),
        }
    }

    pub fn log_environment_now(binary: &str, product_name: &str, identifier: &str) {
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
        // bus, etc.). Blocking is fine: we are on the notifier thread.
        probe();

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
            .body(&escape_body(body))
            .icon(icon_name())
            .hint(notify_rust::Hint::DesktopEntry(desktop_entry_name().into()))
            .hint(notify_rust::Hint::Category(CATEGORY.into()))
            .hint(notify_rust::Hint::Urgency(notify_rust::Urgency::Normal))
            .hint(notify_rust::Hint::SoundName(SOUND_NAME.into()))
            .timeout(notify_rust::Timeout::Milliseconds(TIMEOUT_MS));
        n
    }

    /// Escape the body when the daemon parses it as markup.
    ///
    /// Daemons advertising `body-markup` run the body through a limited
    /// HTML/Pango parser. Chat messages here routinely carry `<`, `&` and code
    /// fences, and an unescaped body either renders mangled or — when the parse
    /// fails outright — is dropped by the daemon. That reads as "notifications
    /// are broken", intermittently, for exactly the messages that happen to
    /// contain a bracket.
    ///
    /// Body only: per the freedesktop spec the summary is never markup, so
    /// escaping it would show users literal `&amp;` in a channel name.
    fn escape_body(body: &str) -> String {
        if !supports("body-markup") {
            return body.to_string();
        }
        // Ampersand first, or the entities introduced below get double-escaped.
        body.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
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

    /// The banner currently on screen for a channel.
    ///
    /// `id` is the `replaces_id` the crate was picked for (see Cargo.toml) and
    /// the direct counterpart of the web push payload's `tag: channel:<id>`:
    /// the next message in a channel supersedes that channel's banner instead
    /// of stacking a new one. Without it a chatty channel buried the tray under
    /// one banner per message, which reads as broken every bit as much as
    /// silence does.
    ///
    /// `watched` prevents a thread pile-up. Every delivery could spawn its own
    /// `wait_for_action` thread, and because replacement reuses the same id
    /// they would *all* still be listening to it — so one click would fire N
    /// navigations and N zbus connections would sit open until the user finally
    /// dismissed the banner. One watcher per live id is enough.
    ///
    /// Entries are dropped when the notification ends, so a message arriving
    /// after the user dismissed a banner opens a fresh one (and re-alerts)
    /// rather than quietly replacing something no longer on screen.
    struct Banner {
        id: u32,
        watched: bool,
    }

    static BANNERS: Mutex<Option<HashMap<String, Banner>>> = Mutex::new(None);

    fn previous_id(channel_id: &str) -> Option<u32> {
        let guard = BANNERS.lock().ok()?;
        Some(guard.as_ref()?.get(channel_id)?.id)
    }

    /// Is this id going unwatched? False when a live thread already has it.
    fn needs_watcher(channel_id: &str, id: u32) -> bool {
        let Ok(guard) = BANNERS.lock() else {
            return false;
        };
        !guard
            .as_ref()
            .and_then(|map| map.get(channel_id))
            .is_some_and(|banner| banner.watched && banner.id == id)
    }

    /// Store the banner now on screen for a channel. `watched` must say
    /// whether a thread is *actually* listening to this id, not whether we
    /// wanted one — see the call site.
    fn record(channel_id: &str, id: u32, watched: bool) {
        if let Ok(mut guard) = BANNERS.lock() {
            guard
                .get_or_insert_with(HashMap::new)
                .insert(channel_id.to_string(), Banner { id, watched });
        }
    }

    /// Forget a banner once it is off screen — but only if it is still the one
    /// we know about. A newer delivery may already have taken this channel's
    /// slot, and dropping that would lose a live `replaces_id`.
    fn forget(channel_id: &str, id: u32) {
        if let Ok(mut guard) = BANNERS.lock() {
            if let Some(map) = guard.as_mut() {
                if map.get(channel_id).is_some_and(|banner| banner.id == id) {
                    map.remove(channel_id);
                }
            }
        }
    }

    /// Does the daemon advertise a capability? GNOME Shell, Plasma, dunst and
    /// mako all differ; `probe()` cached the list on first use.
    fn supports(capability: &str) -> bool {
        probe().caps.iter().any(|c| c == capability)
    }

    /// Called when the user clicks one of our notifications, with the channel
    /// id it carried. Installed by `lib.rs` so this module needs no dependency
    /// on Tauri — it is spawned from a plain worker thread, and keeping the
    /// boundary a callback is what lets the whole module be type-checked for
    /// Linux from a host that isn't Linux.
    type ActivationHandler = Box<dyn Fn(&str) + Send + Sync + 'static>;
    static ON_ACTIVATE: OnceLock<ActivationHandler> = OnceLock::new();

    pub fn set_activation_handler(handler: ActivationHandler) {
        if ON_ACTIVATE.set(handler).is_err() {
            log::warn!("notify: activation handler was already installed");
        }
    }

    /// Wait for the user to act on one notification, on a thread of its own.
    ///
    /// `wait_for_action` consumes the handle and blocks until the daemon
    /// reports either an invoked action or a close, so it cannot run on the
    /// notifier thread — that thread has to stay free to deliver the next
    /// message. Either outcome ends the thread.
    ///
    /// Returns whether the thread actually started, so the caller can leave
    /// `watched` false and try again on the next message if it did not.
    fn watch_for_activation(handle: notify_rust::NotificationHandle, channel_id: String) -> bool {
        let id = handle.id();
        let spawned = std::thread::Builder::new()
            .name("clawbits-notify-action".to_string())
            .spawn(move || {
                handle.wait_for_action(|action| {
                    // notify-rust reports a dismissal as the pseudo-action
                    // "__closed"; anything that isn't our own key is a close.
                    if action == DEFAULT_ACTION {
                        log::info!("notify activated: channel_id={channel_id:?} id={id}");
                        if let Some(handler) = ON_ACTIVATE.get() {
                            handler(&channel_id);
                        } else {
                            log::warn!("notify activated but no handler is installed");
                        }
                    }
                    forget(&channel_id, id);
                });
            });
        match spawned {
            Ok(_) => true,
            Err(err) => {
                log::warn!("notify: could not spawn action watcher: {err}");
                false
            }
        }
    }

    fn deliver_now(message: &ChannelMessage) {
        probe();
        // Body folds the author in since Linux notifications have no
        // subtitle slot. For DMs (where the channel name IS the author)
        // we'd otherwise read "Dmytro Tkachuk: msg" with "Dmytro Tkachuk"
        // already in the title — skip the prefix in that case.
        let body = if message.author_name == message.channel_name {
            message.body.clone()
        } else {
            format!("{}: {}", message.author_name, message.body)
        };
        let replaces = previous_id(&message.channel_id);
        let extra = format!(
            "channel_id={:?} channel_name={:?} author={:?} replaces_id={:?} ",
            message.channel_id, message.channel_name, message.author_name, replaces,
        );
        log_payload(&message.channel_name, &body, "message", &extra);

        let mut notification = base_notification(&message.channel_name, &body);
        if let Some(id) = replaces {
            notification.id(id);
        }
        // Only offered when the daemon says it handles actions at all. Per
        // spec an unsupported action is ignored, but a couple of daemons
        // render a stray button for it instead.
        let actionable = supports("actions");
        if actionable {
            notification.action(DEFAULT_ACTION, "Open");
        }

        match notification.show() {
            Ok(handle) => {
                let id = handle.id();
                log::info!(
                    "notify result (message): OK id={} channel_id={:?}",
                    id,
                    message.channel_id,
                );
                // At most one watcher per live id. A replacement reuses the
                // id, so a thread already waiting on it is still the right
                // one; `||` short-circuits before the handle is moved.
                // Recording last, with whether anything is *actually*
                // listening, keeps a failed spawn from marking it watched.
                let watched = !needs_watcher(&message.channel_id, id)
                    || (actionable && watch_for_activation(handle, message.channel_id.clone()));
                record(&message.channel_id, id, watched);
            }
            Err(err) => log::error!(
                "notify result (message): ERR channel_id={:?} err={err:#}",
                message.channel_id,
            ),
        }
    }

    /// One-shot test notification, triggered from Settings → Notifications.
    /// Lets a user prove out the path without needing a second account to post
    /// a real message. The payload is intentionally minimal and all-ASCII so a
    /// failure can't be blamed on malformed body content.
    ///
    /// Deliberately carries no `replaces_id`: the test must produce a visible
    /// banner every time it is pressed, not silently overwrite the last one.
    fn ping_now() {
        probe();
        let summary = "Clawbits";
        let body = "Test notification - delivery is working.";
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
    fn ensure_appimage_desktop_file() {
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

/// Trigger a hand-crafted test notification through the same delivery path as
/// a real message.
///
/// Reachable from Settings → Notifications on every desktop platform. It used
/// to be Linux-only and DevTools-only, which meant the one platform where
/// delivery is fragile had no way for a user to tell "the daemon dropped it"
/// apart from "the app never sent it" — the log line this produces is exactly
/// that distinction.
pub fn debug_ping() {
    #[cfg(target_os = "linux")]
    linux::enqueue(linux::Job::Ping);

    #[cfg(target_os = "macos")]
    {
        // Routed through the real delivery path rather than a bespoke one, so
        // a passing test genuinely exercises what messages use.
        let message = ChannelMessage {
            channel_id: "clawbits-test".to_string(),
            channel_name: "Clawbits".to_string(),
            author_name: "Clawbits".to_string(),
            body: "Test notification — delivery is working.".to_string(),
        };
        deliver(&message);
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    log::info!("notify debug_ping: no native backend on this platform — no-op");
}
