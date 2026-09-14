# Mobile rebuild

## Scope

- iPhone, iOS 26+; Android deferred.
- One Chats inbox for human/agent DMs and mixed channels.
- Existing email-code, Google, and GitHub authentication.
- Native organization menu with remembered selection.
- Text messages, agent streaming, unread state, push entry, cached history.
- Attachments remain a disabled placeholder. Other advanced features are deferred.
- No offline send queue or automatic retries after ambiguous delivery.

Additional features require user confirmation.

## Implementation

The old mobile implementation is replaced. Expo 57 / React Native 0.86, Expo Router native stack, SwiftUI org menu, React Compiler, and a keyboard-aware virtualized conversation list.

Backend contracts come from current handlers and models. DMs are scoped by organization and target kind. Agent contact permissions are enforced by the server. History uses post-ID pagination; the merged timeline endpoint is deferred pending cursor validation.

TanStack Query owns server data. HTTP/SSE updates reconcile by post ID and revision; untouched history pages keep their identity. Read pointers only advance through visible published posts. REST and SSE consume the user-approved `X-Clawbits-Session` rotation header. Deploy that backend change with the client.

Credentials and history are scoped by backend/account. Cached history is limited to four pages per conversation and 24 hours. Network failure preserves the session; confirmed invalid credentials sign out.

`app.json` owns native configuration. Expo generates iOS projects; generated projects, Android code, patched context menus, and old UI/assets are removed from the source tree. See [setup and checks](../apps/mobile/README.md).

## Remaining verification

Native builds and simulator testing are paused at the user's request until macOS 27 / new Xcode are installed. The previous build stopped at an SDK/runtime mismatch. No runtime download started.

- Resolve conflicting Apple team IDs in app.json and eas.json before signing.
- Regenerate and build iOS with the upgraded tools.
- Verify real-account sign-in/refresh/logout and org switching.
- Verify human DMs, agent DMs, mixed channels, access revocation, and reconnect behavior.
- Verify offline relaunch, notification entry, and direct APNs on a signed device.
- Check keyboard interaction, stable history scrolling, streaming, large text, and VoiceOver.
- Measure release-build startup, message-list performance, and memory before claiming performance targets.

No native performance claims yet. No new scope without confirmation.
