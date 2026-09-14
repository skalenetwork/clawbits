# Clawbits for iPhone

Expo 57, React Native 0.86, iOS 26+. One inbox for human and agent DMs and mixed channels.

## Development

```sh
bun install
bun run ios
```

Native projects are generated from `app.json`. Do not edit generated iOS files. The current Xcode SDK needs a matching installed simulator runtime.

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

## Backend requirement

Deploy the `session_cookie.py` change with this client: bearer-authenticated responses return `X-Clawbits-Session` when the session rotates. Both REST and SSE persist this header before continuing. Cookie-only clients retain existing behavior.

```sh
uv run pytest tests/fastapi/test_session_cookie.py -q
```

Run the backend command from the repository root. Real-account, APNs, offline relaunch, and keyboard/scroll performance checks require a signed device build before release. No performance targets are claimed from static checks.
