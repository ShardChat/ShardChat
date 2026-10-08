/// <reference types="vite/client" />

/**
 * Deployment-time configuration. Both are optional: unset (the default) the
 * client is same-origin, which is how the single-container build works.
 * Set them only when the static bundle and the relay are served from
 * different hosts.
 */
interface ImportMetaEnv {
  /** Origin of the Go relay's REST API, e.g. https://api.example.com */
  readonly VITE_API_BASE?: string;
  /** Origin of the Go relay's WebSocket endpoint, e.g. wss://api.example.com */
  readonly VITE_WS_URL?: string;
  /** Origin of the shard-media SFU node (call signaling + media), e.g. wss://shard-media.onrender.com */
  readonly VITE_MEDIA_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
