/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

// The product version baked into the bundle, read from package.json (kept in
// lock-step with the backend by scripts/bump_version.py). The running server
// announces its own version on the global SSE stream; when the two diverge —
// i.e. a tab has been open across a deploy — the app prompts a reload.
const buildVersion = (
  JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
    version: string
  }
).version

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  // React Compiler is wired via @rolldown/plugin-babel running the
  // preset shipped by @vitejs/plugin-react v6+. It auto-memoizes
  // components and hooks so most useMemo/useCallback/React.memo become
  // unnecessary. Build-time only, no runtime cost. Default target is
  // React 19 which matches package.json.
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: '/',
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    host: true,
    allowedHosts: ['.ts.net', 'localhost', 'myserver'],
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://localhost:8000',
    },
  },
})
