# Clawbits for iPhone

Expo SDK 58 (`next`, not `latest`), React Native 0.88 RC, iOS 26+. One inbox for human and agent DMs and mixed channels.

## Development

```sh
bun install
bun run ios
```

Native projects are generated from `app.json`. Do not edit generated iOS files. The current Xcode SDK needs a matching installed simulator runtime.

Expo is pinned to `58.0.2` on the `next` tag. `npm latest` is still SDK 57, and React Native `0.88.0` is not published yet. SDK 58 generates the iOS 27 scene lifecycle, which this Xcode needs in order to launch. Use the installed SDK's dependency versions until `latest` moves to SDK 58. EAS iOS builds use the `sdk-58` image (Xcode 27.0).

Keep simulator signing enabled for Keychain access. Local Release builds have no EAS update channel; update checks return HTTP 400 while the embedded app runs.

```sh
bun run typecheck
bun run lint
bun test src/lib
bunx expo-doctor
```

Use `EXPO_PUBLIC_CLAWBITS_API_URL` to choose the backend. Account credentials and cached messages are isolated by backend and user. Sign-in uses existing email codes, Google, or GitHub. The organization menu remembers the selected workspace.

## Scope

Text conversations, streamed agent replies, unread state, native organization selection, and notification entry. Existing attachments show a text fallback. No attachment sending, search, reactions, editing, channel administration, or offline send queue.

The cache keeps up to four history pages per opened conversation for 24 hours. Failed sends preserve text. Ambiguous delivery is labeled explicitly and never retried automatically; the server does not provide durable send idempotency.

## Session rotation

Bearer-authenticated responses return `X-Clawbits-Session` when the session rotates; REST and SSE persist it before continuing.
