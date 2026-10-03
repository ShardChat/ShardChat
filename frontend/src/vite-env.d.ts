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
  /** STUN server used when the relay serves no TURN credentials. */
  readonly VITE_STUN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
