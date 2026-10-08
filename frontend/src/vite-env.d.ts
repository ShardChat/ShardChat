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
  /** Call transport strategy: "p2p" (direct WebRTC via the relay's signaling,
   *  default) or "sfu" (media through the shard-media node). Unset → "sfu"
   *  only when VITE_MEDIA_URL is set, otherwise "p2p". */
  readonly VITE_CALL_TRANSPORT?: "p2p" | "sfu";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
