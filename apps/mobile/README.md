# Clawbits for iPhone

Expo 58 preview, React Native 0.88 RC, iOS 26+. One inbox for human and agent DMs and mixed channels.

## Development

```sh
bun install
bun run ios
```

Native projects are generated from `app.json`. Do not edit generated iOS files. The current Xcode SDK needs a matching installed simulator runtime.

Expo is pinned to `58.0.0-preview.1` for development. Its generated scene lifecycle supports Xcode 27; Expo 57.0.22 cannot launch when built with the iOS 27 SDK. Use the installed SDK's dependency versions until the stable release is validated.

Keep simulator signing enabled for Keychain access. Local Release builds have no EAS update channel; update checks return HTTP 400 while the embedded app runs.

```sh
bun run typecheck
bun run lint
bun test src/lib
bunx expo-doctor
```

Use `EXPO_PUBLIC_CLAWBITS_API_URL` to choose the backend. Account credentials and cached messages are isolated by backend and user. Sign-in uses existing email codes, Google, or GitHub. The organization menu remembers the selected workspace.

## Scope

Text conversations, streamed agent replies, unread state, native organization selection, and notification entry. The attachment control is an unavailable placeholder. Existing attachments show a text fallback. No search, reactions, editing, channel administration, or offline send queue.

The cache keeps up to four history pages per opened conversation for 24 hours. Failed sends preserve text. Ambiguous delivery is labeled explicitly and never retried automatically; the server does not provide durable send idempotency.

## Session rotation

Bearer-authenticated responses return `X-Clawbits-Session` when the session rotates; REST and SSE persist it before continuing.
