# Clawbits Desktop

Tauri 2 shell over the Clawbits web frontend at [`../frontend`](../frontend). macOS 11+ universal and Ubuntu 24.04+ (`webkit2gtk-4.1`).

## Dev

```bash
cd desktop
bun install
bun run dev
```

This starts Vite (from `../frontend`) and opens a native window pointing at it. Rust deps compile on first run (~1–2 min cold).

## Icons

Sources live at [`icons-src/{dev,staging,prod}.png`](icons-src/) (1024×1024, edge-to-edge — `scripts/build-icons.mjs` pads them to the macOS icon-grid ratio and runs `tauri icon`). The full bundle is regenerated per build from `CLAWBITS_CHANNEL` (set by CI; defaults to `dev` locally).

## Build

```bash
bun run build
```

Produces:
- `src-tauri/target/release/bundle/dmg/Clawbits_<version>_<arch>.dmg` (macOS)
- `src-tauri/target/release/bundle/deb/clawbits_<version>_<arch>.deb` (Linux, apt-style install)
- `src-tauri/target/release/bundle/appimage/Clawbits_<version>_<arch>.AppImage` (Linux, portable + auto-updatable)

The Linux build auto-merges [`src-tauri/tauri.linux.conf.json`](src-tauri/tauri.linux.conf.json) — disables window transparency (GTK has no vibrancy), pulls in `libnotify4`, and applies the custom [`clawbits.desktop`](src-tauri/clawbits.desktop) template (adds `GenericName`, `Keywords`, `StartupWMClass`, `MimeType`).

### Linux auto-updates

Tauri's auto-updater can replace the running binary only when the app is itself a single-file executable — i.e., the `.AppImage`. The `.deb` install puts the binary at `/usr/bin/clawbits` (root-owned) which the updater can't rewrite without sudo. So:

- **AppImage users**: auto-updates work end-to-end. The plugin downloads the new tarball, replaces the binary, and the user clicks "Restart & update".
- **.deb users**: the updater shows the toast and tells them a new version exists, but the install step fails silently — they need to download the next `.deb` manually (or you can publish to a real apt repo).

On **all** desktops, ⌘W / red-X / the dock's right-click "Quit" now **hide** the window and the app keeps running in the background, so the SSE stream that feeds desktop notifications stays alive (this is what makes notifications keep arriving after the window is closed on Ubuntu). The tray is always *attempted*: KDE / Cinnamon / MATE / XFCE / Unity **and Ubuntu's default GNOME** (which ships the AppIndicator extension) render a Show/Quit icon; a bare GNOME session with no StatusNotifierItem host simply doesn't show it, with no error.

Bring the window back via the tray's Show, the **Ctrl+Shift+C** global shortcut (X11; Wayland may block it — use the tray or Background Apps menu there), GNOME's **Background Apps** menu (24.04+), or by relaunching (single-instance focuses the running window). **Truly exit** via the tray's Quit, the app menu's Quit (⌘/Ctrl+Q), or GNOME's Background Apps → Quit — these call `app.exit()` and bypass the close-to-hide handler. The dock's right-click "Quit" sends the same `WM_DELETE_WINDOW` as the X button, so it now hides rather than exits.

## Unsigned macOS install

Until we enroll in the Apple Developer Program, users will hit Gatekeeper on first launch. Workaround:

```bash
xattr -cr /Applications/Clawbits.app
```

Or right-click → Open → confirm once.

## Verifying on Ubuntu

Install the .deb and confirm:

```bash
sudo dpkg -i clawbits-staging_<version>_amd64.deb   # or clawbits_<version>_amd64.deb for prod
sudo apt-get install -f       # fixes missing libnotify4 etc. if dpkg complained
```

Checks worth doing after install:

- **App icon + description** in GNOME Software / app drawer search ("clawbits-staging"): icon matches the channel build, `GenericName` shows "AI Agent Messaging (Staging)", search terms from `Keywords=` work.
- **Notifications**: **Settings → Notifications → Send a test**, or trigger one from another account. That panel also reports the notification daemon it found and whether a matching `.desktop` file is installed. If the icon is missing or notifications don't appear, follow the diagnostic flow in the next section.
- **About dialog** (app menu → About clawbits-staging): name, version, icon, comment, website, copyright all populated.
- **Deep link**: `xdg-open clawbits-staging://oauth-callback?token=foo` (or `clawbits://...` for prod) should focus the running app and trigger the auth flow.
- **Window chrome**: solid window background (no see-through to desktop), menu bar (Edit/View/Window) has a proper background.
- **Close hides, app keeps running**: red-X / `Cmd-W` hide the window but the process stays up (`pgrep clawbits-staging` still lists it), so notifications keep arriving. Reopen via the tray's Show, `Ctrl+Shift+C`, GNOME's Background Apps menu, or relaunch.
- **Clicking a notification** raises the window and lands on the channel the message came from. Needs the daemon to advertise the `actions` capability (Settings → Notifications lists what yours reports); without it the banner still shows, it just isn't clickable. Not yet wired on macOS.
- **A busy channel doesn't stack banners**: a second message in the same channel replaces the first rather than adding to the tray. Look for `replaces_id=Some(N)` in the log.
- **Quit fully exits**: the tray's Quit, app-menu Quit (`Ctrl+Q`), or Background Apps → Quit terminate the process (`pgrep clawbits-staging` then returns nothing).

### Diagnosing Linux notifications

Every run logs notification diagnostics to a file. The path is per channel:

| Channel | Log file |
| --- | --- |
| Prod    | `~/.local/share/ai.clawbits.desktop/logs/clawbits.log` |
| Staging | `~/.local/share/ai.clawbits.staging/logs/clawbits.log` |
| Dev     | `~/.local/share/ai.clawbits.dev/logs/clawbits.log` |

Reproduction recipe — run after installing the .deb:

1. **Launch from a terminal** so stdout is also visible:
   ```bash
   clawbits-staging
   ```
2. **Either** receive a real chat message **or** press **Send a test** in Settings → Notifications — both go through the same code path with full payload logging. (The same command is still reachable from DevTools, `View → Toggle DevTools` / `Cmd+Alt+I`, as `await window.__TAURI_INTERNALS__.invoke('notify_debug_ping')`.)
3. **Grab the log** and share it back:
   ```bash
   cat ~/.local/share/ai.clawbits.staging/logs/clawbits.log
   ```

What to look for in the log:

- A `--- notification environment ---` block at the top of each run. It dumps `XDG_CURRENT_DESKTOP`, the resolved executable path, every checked `.desktop` file location, whether `notify-send` is installed, and the notification daemon's identity + capabilities.
- `.desktop check: ... -> FOUND` for at least one path with basename matching `desktop_entry_name`. **If every path says `missing`**, GNOME Shell silently drops our notifications — the install didn't register a `.desktop` file the Shell can match against. The `.deb` registers one system-wide; **AppImage** runs self-register one to `~/.local/share/applications/<slug>.desktop` on first launch — look for `appimage integration: wrote ...` (or `... already current`) in the log. If that line is missing on an AppImage run, `APPIMAGE`/`HOME` weren't set.
- `notify server: name=... vendor=...` — confirms D-Bus reached a daemon. Missing this line means D-Bus itself is failing (sandbox, no daemon).
- Per delivery: `notify send (message): ...` lists the exact summary, body, and every hint (icon, category, urgency, sound, timeout), plus the `replaces_id` being reused for that channel. `notify result (...): OK id=N` or `ERR err=...` follows.
- **The first thing to check, before anything above.** If a message produced no banner and there is *no* `notify send (message):` line for it at all, the shell never tried — the failure is in the frontend gate, not in D-Bus, and nothing else in this section applies. (This is what `isAppInForeground()` in `frontend/src/lib/desktop.ts` exists to get right: the app suppresses notifications while you are looking at it, and it must not mistake a window hidden to the tray for a focused one.)

Cross-checks that quickly localize the failure:

- `notify-send -a clawbits-staging "test" "from notify-send"` — if this works but our app doesn't, our hint set is the problem; if neither works, the daemon / desktop env is the problem.
- `journalctl --user -f` while triggering — D-Bus errors from `org.freedesktop.Notifications` surface here.
- `gsettings get org.gnome.desktop.notifications application-children` — confirms our `.desktop` basename is registered with the Shell.
- `update-desktop-database ~/.local/share/applications` — sometimes needed after install before the Shell sees the file.

### Migrating from clawbits-desktop <= 0.2.2 on Linux

If you installed a build older than 0.2.3 and notifications never worked, GNOME may be carrying a stale per-app mute keyed by the canonicalized notification slug (`clawbits-staging`). Clear it once:

```bash
# Identify whatever GNOME registered:
gsettings list-recursively org.gnome.desktop.notifications.application | grep -i claw

# Reset the per-app key (use the slug from the line above):
dconf reset -f /org/gnome/desktop/notifications/application/clawbits-staging/
# Or for the prod channel:
# dconf reset -f /org/gnome/desktop/notifications/application/clawbits/
```

After that, real notifications and `notify-send -a clawbits-staging "test"` should both produce a visible banner. This is only needed once per machine that was affected.

### Channel naming convention

The notification breakage diagnosed in 0.2.1/0.2.2 had a root cause in [tauri-bundler](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs): the `.deb` installer derives the `.desktop` filename from `productName` (with spaces preserved) but icon basenames from `mainBinaryName`. The two don't match for any multi-word product name, and GNOME requires the `DesktopEntry` hint to match the file basename exactly.

The fix is to **never let those two names diverge per-platform.** On Linux, every channel uses a single hyphenated lowercase slug everywhere — `productName`, `mainBinaryName`, the `.desktop` file basename, the `.desktop` `Name=` field, and the GNOME notification slug all match exactly. The prod `productName` is capitalized for the macOS Dock / Finder display only, with [`tauri.linux.conf.json`](src-tauri/tauri.linux.conf.json) overriding it back to lowercase for Linux so the slug invariant holds.

| Channel | macOS `.app` bundle | Linux slug (all surfaces) | GNOME notification slug |
| --- | --- | --- | --- |
| Prod    | `Clawbits.app`         | `clawbits`         | `clawbits` |
| Staging | `clawbits-staging.app` | `clawbits-staging` | `clawbits-staging` |
| Dev     | `clawbits-dev.app`     | `clawbits-dev`     | `clawbits-dev` |

Trade-off: on Linux the slug appears verbatim in the GNOME app drawer, GNOME Settings → Notifications, and the window title — including for the prod channel, which shows `clawbits` rather than `Clawbits`. We accept that in exchange for a single source of truth on Linux — no two-name divergence inside `.deb`, no risk of the bundler-vs-hint mismatch returning. macOS gets the capitalized display via the base config; Linux is force-overridden via the platform conf so `mainBinaryName == productName == DesktopEntry hint` holds.

If a future channel needs a polished label in some Linux surface, add it back as a localized override in that one place only.
