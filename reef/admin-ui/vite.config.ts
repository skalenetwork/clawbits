import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The UI is same-origin in the browser; Vite proxies /api -> the Reef API so we
// avoid CORS and keep the admin token off the client in dev.
const target = process.env.VITE_REEF_API_TARGET || 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
})
