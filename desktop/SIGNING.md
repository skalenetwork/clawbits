# macOS code signing + notarization (DEFERRED - runbook)

> Status: **not yet enabled.** Waiting on Apple Developer Program approval. This
> file is the drop-in procedure; the release workflow already carries a commented
> scaffold (see `.github/workflows/desktop-release.yml`, the "Build with Tauri"
> step). Enabling is: create the credentials below -> add the GitHub secrets ->
> uncomment the env block -> drop the ad-hoc `signingIdentity`.

## Why this matters

Two *separate* kinds of signing are involved. Don't confuse them:

| Signing | Purpose | Status |
| --- | --- | --- |
| **Updater (minisign)** | Proves an update artifact came from us; the updater plugin verifies it against the embedded `pubkey`. | **Already done** (`TAURI_SIGNING_PRIVATE_KEY`). |
| **Apple Developer ID + notarization** | Proves the *app* is from an identified developer so macOS Gatekeeper runs it without warnings. | **This document.** |

Today the app is **ad-hoc signed** (`bundle.macOS.signingIdentity: "-"` in
`desktop/src-tauri/tauri.conf.json`). Consequences:

- **First launch:** Gatekeeper shows "Apple could not verify Clawbits is free of
  malware", and the user must right-click -> Open or visit System Settings ->
  Privacy & Security. Poor first impression.
- **Auto-updates:** the minisign signature still verifies the download, so the
  update mechanism works - but the resulting bundle stays ad-hoc signed, which is
  increasingly fragile on recent macOS (quarantine / Gatekeeper re-checks).

Developer ID signing + notarization removes the warning entirely and makes the
updated bundle trusted.

## Prerequisites

- **Apple Developer Program** membership ($99/yr) - the pending item.
- The **Team ID** (10 chars, e.g. `AB12CD34EF`) from the Apple Developer account.

## Step 1 - Developer ID Application certificate

1. Xcode -> Settings -> Accounts -> your team -> **Manage Certificates** -> **+**
   -> **Developer ID Application**. (Or create it in the Apple Developer portal.)
2. Find it in **Keychain Access** -> My Certificates. The identity string is
   `Developer ID Application: YOUR NAME (TEAMID)` - this is `APPLE_SIGNING_IDENTITY`.
3. Right-click the cert (with its private key) -> **Export** -> `.p12`, set a
   password (this is `APPLE_CERTIFICATE_PASSWORD`).
4. Base64-encode it for the secret:
   ```bash
   base64 -i certificate.p12 | pbcopy   # now in clipboard -> APPLE_CERTIFICATE
   ```

## Step 2 - Notarization credentials (pick ONE)

**Option A - App Store Connect API key (recommended for CI):**
1. App Store Connect -> Users and Access -> **Integrations / Keys** -> **+**,
   role *Developer*. Download the `.p8` **once**.
2. Note the **Key ID** (`APPLE_API_KEY`) and **Issuer ID** (`APPLE_API_ISSUER`).
3. The `.p8` contents go into a secret; the workflow writes it to a file and
   points `APPLE_API_KEY_PATH` at it (see Step 5 variant).

**Option B - Apple ID app-specific password (simplest secrets):**
1. <https://account.apple.com> -> Sign-In and Security -> **App-Specific
   Passwords** -> generate one. That value is `APPLE_PASSWORD`.
2. `APPLE_ID` is the Apple account email; `APPLE_TEAM_ID` is the Team ID.

The workflow scaffold below uses **Option B** inline (no file handling). Switch to
Option A by swapping the three `APPLE_ID/PASSWORD/TEAM_ID` vars for the API-key
trio and adding a step that writes the `.p8`.

## Step 3 - GitHub repository secrets

Settings -> Secrets and variables -> Actions -> **New repository secret**:

| Secret | From |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the `.p12` (Step 1.4) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password (Step 1.3) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)` (Step 1.2) |
| `APPLE_ID` | Apple account email (Option B) |
| `APPLE_PASSWORD` | app-specific password (Option B) |
| `APPLE_TEAM_ID` | 10-char Team ID |

`tauri-action` auto-imports `APPLE_CERTIFICATE` into a temporary keychain when the
env var is present - no manual `security create-keychain` step needed.

## Step 4 - Drop the ad-hoc identity

In `desktop/src-tauri/tauri.conf.json`, the ad-hoc `"-"` **overrides** any env
identity and must go. Change:

```jsonc
"macOS": {
  "minimumSystemVersion": "11.0",
  "signingIdentity": "-"          // <- ad-hoc; remove this line
}
```
to:
```jsonc
"macOS": {
  "minimumSystemVersion": "11.0"
}
```
With no `signingIdentity` in config, Tauri uses the `APPLE_SIGNING_IDENTITY` env
var. (Local `tauri build` with no Apple env then produces an *unsigned* bundle,
which is fine for local runs; set `APPLE_SIGNING_IDENTITY=-` locally if you still
want ad-hoc.)

Notarization requires the **hardened runtime**, which Tauri enables automatically
for Developer ID signing - no extra config. `macOSPrivateApi: true` (window
transparency) is **fine** for Developer ID notarized distribution; only App Store
review rejects private-API use, not notarization.

## Step 5 - Enable the workflow env

Uncomment the `APPLE_*` block in the "Build with Tauri" step of
`.github/workflows/desktop-release.yml`. When those vars are present, the Tauri
bundler signs with the Developer ID cert and runs `notarytool` + staples the
ticket during the build. No other workflow change is required.

*(Option A variant: add a step before "Build with Tauri" that does
`echo "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/asc.p8"`, set `APPLE_API_KEY_PATH:
${{ runner.temp }}/asc.p8`, and use `APPLE_API_KEY` / `APPLE_API_ISSUER`.)*

## Step 6 - Verify a build

```bash
# Signed with our Developer ID, hardened runtime on:
codesign -dv --verbose=4 /path/to/Clawbits.app
# Gatekeeper accepts it for distribution:
spctl -a -vvv -t install /path/to/Clawbits.app
# Notarization ticket is stapled:
xcrun stapler validate /path/to/Clawbits.app
```

All three should pass. Then download an older build and confirm an auto-update
installs and relaunches with no Gatekeeper prompt.

## Notes

- Keep `createUpdaterArtifacts: true` and the minisign keys - notarization is
  *additive*, not a replacement for updater signing.
- The `latest.json` generation and updater endpoints are unaffected.
- Linux (AppImage) needs none of this.
