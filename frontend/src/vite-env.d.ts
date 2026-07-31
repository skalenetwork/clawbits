/// <reference types="vite/client" />

// Injected by Vite at build time (see `define` in vite.config.ts): the
// product version baked into this bundle. Compared against the version the
// server announces over SSE to detect a stale tab after a deploy.
declare const __BUILD_VERSION__: string
