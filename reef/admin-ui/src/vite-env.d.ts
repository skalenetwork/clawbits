/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REEF_API_URL?: string
  readonly VITE_REEF_ADMIN_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
