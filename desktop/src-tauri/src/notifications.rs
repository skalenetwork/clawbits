//! Per-channel desktop notifications. macOS gives every message a fresh id so it
//! banners, grouped per channel by `threadIdentifier`; Linux has no grouping, so a
//! channel's next message replaces its banner (`replaces_id`), like web push's `tag`.
//! A game's turn ping has no Reply and a slot of its own, `turn:{channel}` (the macOS
//! request id, the Linux banner key), so it and a message never replace each other and
//! the chat's next turn ping replaces it, as web push's tag and the APNs collapse id do.
//! Bundled macOS builds use UNUserNotificationCenter; the unbundled dev binary has no
//! bundle for it and posts NSUserNotifications under Terminal's identity.

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    channel_id: String,
    channel_name: String,
    author_name: String,
    body: String,
    /// `"turn"` for a game's "Your move" ping; a chat message sends none.
    #[serde(default)]
    kind: Option<String>,
    /// The game a turn ping opens.
    #[serde(default)]
    widget_id: Option<String>,
}

impl ChannelMessage {
    /// The author, unless the channel is a DM already named after them.
    fn author(&self) -> Option<&str> {
        (self.author_name != self.channel_name).then_some(self.author_name.as_str())
    }

    /// A turn ping has no Reply and a banner of its own, beside the channel's message banner.
    fn is_turn(&self) -> bool {
        self.kind.as_deref() == Some("turn")
    }

    /// A turn ping's game, if its id can go into a URL as is (the server's are hex).
    fn widget(&self) -> Option<&str> {
        let id = self.widget_id.as_deref().filter(|_| self.is_turn())?;
        (!id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then_some(id)
    }

    /// A turn ping's slot, `turn:{channel}`, which the chat's next turn ping replaces; none for a message.
    fn turn_key(&self) -> Option<String> {
        self.is_turn().then(|| format!("turn:{}", self.channel_id))
    }
}

/// What the user did with one of our notifications.
pub enum Activation {
    /// Clicked it: open that channel (empty for the test notification), at a turn ping's game.
    Open { channel_id: String, widget_id: Option<String> },
    /// Answered from the banner (macOS).
    #[cfg_attr(target_os = "linux", allow(dead_code, reason = "Linux has no inline reply"))]
    Reply(Reply),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    channel_id: String,
    text: String,
}

type ActivationHandler = Box<dyn Fn(Activation) + Send + Sync>;

/// Installs the callback for clicks and banner replies. Call once at startup.
pub fn set_activation_handler(handler: impl Fn(Activation) + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    if !tauri::is_dev() {
        macos::set_activation_handler(Box::new(handler));
    }
    #[cfg(target_os = "linux")]
    let _ = linux::ON_ACTIVATE.set(Box::new(handler));
}

fn deliver(message: ChannelMessage) {
    log::info!("notify: channel={:?} kind={:?}", message.channel_id, message.kind);
    #[cfg(target_os = "macos")]
    if tauri::is_dev() {
        macos::deliver_legacy(&message);
    } else {
        macos::deliver(&message);
    }
    #[cfg(target_os = "linux")]
    linux::enqueue(linux::Job::Message(message));
}

/// Sync, so it runs on the main thread NSUserNotification needs; Linux only enqueues.
#[tauri::command]
pub fn notify_channel_message(message: ChannelMessage) {
    deliver(message);
}

/// Settings → Notifications "Send a test", through the same path as a message.
#[tauri::command]
pub fn notify_debug_ping() {
    #[cfg(target_os = "macos")]
    deliver(ChannelMessage {
        channel_id: String::new(),
        channel_name: "Clawbits".into(),
        author_name: "Clawbits".into(),
        body: "Test notification — delivery is working.".into(),
        kind: None,
        widget_id: None,
    });
    #[cfg(target_os = "linux")]
    linux::enqueue(linux::Job::Ping);
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject},
        AllocAnyThread, DefinedClass,
    };
    use objc2_foundation::{ns_string, NSArray, NSDictionary, NSError, NSSet, NSString, NSUUID};
    #[allow(deprecated)]
    use objc2_foundation::{NSUserNotification, NSUserNotificationCenter, NSUserNotificationDefaultSoundName};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationActionOptions,
        UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationInterruptionLevel,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNTextInputNotificationAction, UNTextInputNotificationResponse, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    use super::{Activation, ActivationHandler, ChannelMessage, Reply};

    const CATEGORY: &str = "message";
    const REPLY: &str = "reply";
    /// The `userInfo` key that carries a turn ping's game to the click.
    const WIDGET_ID: &str = "widgetId";

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and Delegate has no Drop.
        #[unsafe(super(NSObject))]
        #[ivars = ActivationHandler]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let content = response.notification().request().content();
                let channel_id = content.threadIdentifier().to_string();
                let widget_id = content
                    .userInfo()
                    .objectForKey(&NSString::from_str(WIDGET_ID))
                    .and_then(|id| id.downcast::<NSString>().ok())
                    .map(|id| id.to_string());
                (self.ivars())(match response.downcast_ref::<UNTextInputNotificationResponse>() {
                    Some(reply) if response.actionIdentifier().to_string() == REPLY => {
                        Activation::Reply(Reply { channel_id, text: reply.userText().to_string() })
                    }
                    _ => Activation::Open { channel_id, widget_id },
                });
                completion_handler.call(());
            }
        }
    );

    /// Registers the Reply action every message carries. The center holds its
    /// delegate weakly, so this one lives as long as the process.
    pub fn set_activation_handler(handler: ActivationHandler) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let reply = UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
            &NSString::from_str(REPLY),
            ns_string!("Reply"),
            UNNotificationActionOptions::empty(),
            ns_string!("Send"),
            ns_string!("Reply…"),
        );
        let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(CATEGORY),
            &NSArray::from_retained_slice(&[Retained::into_super(reply)]),
            &NSArray::new(),
            UNNotificationCategoryOptions::empty(),
        );
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(handler)), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);
    }

    /// The first delivery asks for permission; later ones get the stored answer at once.
    pub fn deliver(message: &ChannelMessage) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&message.channel_name));
        if let Some(author) = message.author() {
            content.setSubtitle(&NSString::from_str(author));
        }
        content.setBody(&NSString::from_str(&message.body));
        content.setThreadIdentifier(&NSString::from_str(&message.channel_id));
        if !message.is_turn() {
            content.setCategoryIdentifier(&NSString::from_str(CATEGORY));
        }
        content.setInterruptionLevel(UNNotificationInterruptionLevel::Active);
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        // A turn ping's id is its chat's slot, so the chat's next turn ping replaces it, a newer
        // game's too; the game it opens rides in userInfo.
        let identifier = match message.turn_key() {
            Some(key) => NSString::from_str(&key),
            None => NSUUID::new().UUIDString(),
        };
        if let Some(widget_id) = message.widget() {
            let key = NSString::from_str(WIDGET_ID);
            let info = NSDictionary::from_slices(&[&*key], &[&*NSString::from_str(widget_id)]);
            // SAFETY: the generics are only the type checker's, so a dictionary of strings is an
            // NSDictionary of objects; userInfo takes property-list keys and values, as strings are.
            unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
        let post = RcBlock::new(move |granted: Bool, _: *mut NSError| {
            if granted.as_bool() {
                UNUserNotificationCenter::currentNotificationCenter()
                    .addNotificationRequest_withCompletionHandler(&request, None);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &post,
        );
    }

    #[allow(deprecated)]
    pub fn deliver_legacy(message: &ChannelMessage) {
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(&message.channel_name)));
        notification.setSubtitle(message.author().map(NSString::from_str).as_deref());
        notification.setInformativeText(Some(&NSString::from_str(&message.body)));
        notification.setHasActionButton(false);
        notification.setSoundName(Some(unsafe { NSUserNotificationDefaultSoundName }));
        NSUserNotificationCenter::defaultUserNotificationCenter().deliverNotification(&notification);
    }
}

/// One notifier thread owns every D-Bus call: they block, and with no daemon running
/// D-Bus waits up to 25s to service-activate one. It also serialises the `replaces_id`
/// bookkeeping, and its FIFO order lands the AppImage `.desktop` before any message.
#[cfg(target_os = "linux")]
pub mod linux {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

    use notify_rust::{Hint, Notification, NotificationHandle, Timeout, Urgency};
    use serde::Serialize;

    use super::{Activation, ActivationHandler, ChannelMessage};

    /// freedesktop's key for a click on the body; daemons draw no button for it.
    const DEFAULT_ACTION: &str = "default";

    /// The `.desktop` basename and icon name: productName and mainBinaryName share it.
    static SLUG: OnceLock<String> = OnceLock::new();
    pub(super) static ON_ACTIVATE: OnceLock<ActivationHandler> = OnceLock::new();
    static QUEUE: OnceLock<Sender<Job>> = OnceLock::new();

    fn slug() -> &'static str {
        SLUG.get().map_or("clawbits", String::as_str)
    }

    pub(super) enum Job {
        Message(ChannelMessage),
        Ping,
        Boot,
    }

    pub fn init(slug: String) {
        let _ = SLUG.set(slug);
        enqueue(Job::Boot);
    }

    pub(super) fn enqueue(job: Job) {
        let queue = QUEUE.get_or_init(|| {
            let (tx, rx) = channel();
            let spawned = std::thread::Builder::new().name("clawbits-notify".into()).spawn(move || {
                for job in rx {
                    match job {
                        Job::Message(message) => deliver(&message),
                        Job::Ping => {
                            show("ping", &notification("Clawbits", "Test notification - delivery is working."));
                        }
                        Job::Boot => {
                            ensure_appimage_desktop_file();
                            log_environment();
                        }
                    }
                }
            });
            if let Err(err) = spawned {
                log::error!("notify: could not spawn the notifier thread: {err}");
            }
            tx
        });
        if queue.send(job).is_err() {
            log::error!("notify: notifier thread is gone, dropping job");
        }
    }

    struct Probe {
        server: Option<String>,
        caps: Vec<String>,
        error: Option<String>,
    }

    /// The daemon's name and capabilities, asked once. Blocking D-Bus round trips.
    fn probe() -> &'static Probe {
        static PROBE: OnceLock<Probe> = OnceLock::new();
        PROBE.get_or_init(|| {
            let server = notify_rust::get_server_information();
            let caps = notify_rust::get_capabilities();
            log::info!("notify server: {server:?} caps: {caps:?}");
            Probe {
                error: server.as_ref().err().or(caps.as_ref().err()).map(ToString::to_string),
                server: server.ok().map(|info| info.name),
                caps: caps.unwrap_or_default(),
            }
        })
    }

    fn supports(capability: &str) -> bool {
        probe().caps.iter().any(|c| c == capability)
    }

    /// What Settings → Notifications reports. A missing `desktop_file` is the
    /// telling failure: GNOME drops what it can't attribute.
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Diagnostics {
        server_name: Option<String>,
        desktop_entry: String,
        desktop_file: Option<String>,
        error: Option<String>,
    }

    /// Off the main thread: the probe may wait on D-Bus.
    #[tauri::command]
    pub async fn notify_diagnostics() -> Option<Diagnostics> {
        tauri::async_runtime::spawn_blocking(diagnostics).await.ok()
    }

    fn diagnostics() -> Diagnostics {
        let probe = probe();
        Diagnostics {
            server_name: probe.server.clone(),
            desktop_entry: slug().to_string(),
            desktop_file: desktop_file().map(|path| path.display().to_string()),
            error: probe.error.clone(),
        }
    }

    /// The installed `.desktop` GNOME matches our `DesktopEntry` hint against.
    fn desktop_file() -> Option<PathBuf> {
        let home = env("HOME").map(|home| Path::new(&home).join(".local/share"));
        let appdir = env("APPDIR").map(|dir| Path::new(&dir).join("usr/share"));
        let xdg = env("XDG_DATA_DIRS").unwrap_or_default();
        ["/usr/share", "/usr/local/share"]
            .map(PathBuf::from)
            .into_iter()
            .chain(home)
            .chain(appdir)
            .chain(xdg.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from))
            .map(|dir| dir.join(format!("applications/{}.desktop", slug())))
            .find(|path| path.exists())
    }

    fn log_environment() {
        for var in [
            "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "GDMSESSION",
            "XDG_DATA_HOME", "XDG_DATA_DIRS", "APPIMAGE", "APPDIR", "SNAP", "FLATPAK_ID", "container",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            log::info!("env {var}={:?}", std::env::var(var).ok());
        }
        log::info!("executable: {:?}", std::env::current_exe().ok());
        log::info!("notify diagnostics: {:?}", diagnostics());
    }

    /// GNOME drops a notification unless `DesktopEntry` equals our `.desktop` basename,
    /// and prefers `appname` over it when both are set, so there is none.
    fn notification(summary: &str, body: &str) -> Notification {
        let mut notification = Notification::new();
        notification
            .summary(summary)
            .body(&escape(body))
            .icon(slug())
            .hint(Hint::DesktopEntry(slug().into()))
            .hint(Hint::Category("im.received".into()))
            .hint(Hint::Urgency(Urgency::Normal))
            .hint(Hint::SoundName("message-new-instant".into()))
            .timeout(Timeout::Milliseconds(5_000));
        notification
    }

    /// Daemons that parse the body as markup mangle or drop `<` and `&`. The summary is never markup.
    fn escape(body: &str) -> String {
        if !supports("body-markup") {
            return body.to_string();
        }
        body.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }

    fn show(kind: &str, notification: &Notification) -> Option<NotificationHandle> {
        log::info!("notify send ({kind}): {notification:?}");
        notification.show().inspect_err(|err| log::error!("notify {kind} failed: {err:#}")).ok()
    }

    /// The banner on screen per key (the channel, or `turn:{channel}` for its turn ping),
    /// which the key's next banner replaces. `watched` keeps it to one action-watcher
    /// thread per id; `widget_id` is the game a turn banner shows now.
    struct Banner {
        id: u32,
        watched: bool,
        widget_id: Option<String>,
    }

    static BANNERS: Mutex<BTreeMap<String, Banner>> = Mutex::new(BTreeMap::new());

    fn banners() -> MutexGuard<'static, BTreeMap<String, Banner>> {
        BANNERS.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn deliver(message: &ChannelMessage) {
        let body = match message.author() {
            Some(author) => format!("{author}: {}", message.body),
            None => message.body.clone(),
        };
        let mut notification = notification(&message.channel_name, &body);
        let (kind, key) = match message.turn_key() {
            Some(key) => ("turn", key),
            None => ("message", message.channel_id.clone()),
        };
        if let Some(banner) = banners().get(&key) {
            notification.id(banner.id);
        }
        let actionable = supports("actions");
        if actionable {
            notification.action(DEFAULT_ACTION, "Open");
        }
        let Some(handle) = show(kind, &notification) else { return };
        let id = handle.id();
        let watched = banners().get(&key).is_some_and(|banner| banner.watched && banner.id == id);
        let watched = watched || (actionable && watch(handle, key.clone(), message.channel_id.clone()));
        banners().insert(key, Banner { id, watched, widget_id: message.widget().map(str::to_owned) });
    }

    /// `wait_for_action` blocks until a click or close, so it gets a thread of its own.
    /// False when that thread could not start, so the next banner tries again.
    fn watch(handle: NotificationHandle, key: String, channel_id: String) -> bool {
        let id = handle.id();
        std::thread::Builder::new()
            .name("clawbits-notify-action".into())
            .spawn(move || {
                handle.wait_for_action(|action| {
                    // Read at the click: a turn banner replaced in place may show a newer game.
                    let mut banners = banners();
                    let widget_id = match banners.get(&key) {
                        Some(banner) if banner.id == id => banners.remove(&key).and_then(|banner| banner.widget_id),
                        _ => None,
                    };
                    drop(banners);
                    if action == DEFAULT_ACTION && let Some(handler) = ON_ACTIVATE.get() {
                        handler(Activation::Open { channel_id: channel_id.clone(), widget_id });
                    }
                });
            })
            .inspect_err(|err| log::warn!("notify: could not spawn an action watcher: {err}"))
            .is_ok()
    }

    fn env(var: &str) -> Option<String> {
        std::env::var(var).ok().filter(|value| !value.is_empty())
    }

    /// AppImages install no `.desktop`, so GNOME would drop every notification: write one
    /// (also registering the deep-link scheme) and the icon, unless already current.
    fn ensure_appimage_desktop_file() {
        let (Some(appimage), Some(home)) = (env("APPIMAGE"), env("HOME")) else { return };
        let slug = slug();
        let apps = Path::new(&home).join(".local/share/applications");
        let target = apps.join(format!("{slug}.desktop"));
        let exec = format!("Exec={appimage} %u");
        if std::fs::read_to_string(&target).is_ok_and(|existing| existing.contains(&exec)) {
            return;
        }
        let contents = format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName={slug}\nGenericName=AI Agent Messaging\n\
             Comment=Cloud sharing hub for AI agents\n{exec}\nIcon={slug}\nTerminal=false\n\
             Categories=Network;InstantMessaging;\nKeywords=chat;messaging;agents;ai;bots;clawbits;\n\
             StartupNotify=true\nStartupWMClass={slug}\nMimeType=x-scheme-handler/{slug};\n\
             X-GNOME-UsesNotifications=true\n"
        );
        if let Err(err) = std::fs::create_dir_all(&apps).and_then(|()| std::fs::write(&target, contents)) {
            log::warn!("appimage integration: writing {} failed: {err}", target.display());
            return;
        }
        if let Some(appdir) = env("APPDIR") {
            let appdir = Path::new(&appdir);
            let icons = Path::new(&home).join(".local/share/icons/hicolor/256x256/apps");
            let icon = icons.join(format!("{slug}.png"));
            let source = [
                appdir.join(format!("usr/share/icons/hicolor/256x256/apps/{slug}.png")),
                appdir.join(format!("{slug}.png")),
                appdir.join(".DirIcon"),
            ]
            .into_iter()
            .find(|path| path.is_file());
            if let Some(source) = source.filter(|_| !icon.is_file()) {
                let copied = std::fs::create_dir_all(&icons).and_then(|()| std::fs::copy(&source, &icon));
                log::info!("appimage integration: icon {} -> {}: {copied:?}", source.display(), icon.display());
            }
        }
        let refreshed = std::process::Command::new("update-desktop-database").arg(&apps).status();
        log::info!("appimage integration: wrote {}, update-desktop-database: {refreshed:?}", target.display());
    }
}

#[cfg(test)]
mod tests {
    use super::ChannelMessage;

    fn parse(json: &str) -> ChannelMessage {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_message_from_a_frontend_without_kind_still_parses() {
        let message = parse(r#"{"channelId":"c1","channelName":"Bob","authorName":"Bob","body":"hi"}"#);
        assert!(!message.is_turn());
        assert_eq!((message.widget(), message.turn_key(), message.author()), (None, None, None));
    }

    #[test]
    fn a_turn_ping_takes_its_chats_slot_and_opens_its_game() {
        let message = parse(
            r#"{"channelId":"c1","channelName":"Your move","authorName":"Your move","body":"Chess with Bob","kind":"turn","widgetId":"0f3a9c2b"}"#,
        );
        assert!(message.is_turn());
        assert_eq!(message.turn_key().as_deref(), Some("turn:c1"));
        assert_eq!(message.widget(), Some("0f3a9c2b"));
        assert_eq!(message.author(), None);
    }

    #[test]
    fn a_game_opens_only_from_a_turn_ping_with_an_id_fit_for_a_url() {
        let with = |extra: &str| parse(&format!(r#"{{"channelId":"c1","channelName":"n","authorName":"a","body":"b",{extra}}}"#));
        assert_eq!(with(r#""kind":"turn","widgetId":"A-z_9""#).widget(), Some("A-z_9"));
        for extra in [
            r#""kind":null,"widgetId":null"#,
            r#""widgetId":"abc""#,
            r#""kind":"message","widgetId":"abc""#,
            r#""kind":"Turn","widgetId":"abc""#,
            r#""kind":"turn","widgetId":"""#,
            r#""kind":"turn","widgetId":"a?b=c""#,
            r#""kind":"turn","widgetId":"../x""#,
            r#""kind":"turn","widgetId":"é""#,
        ] {
            assert_eq!(with(extra).widget(), None, "{extra}");
        }
    }
}
