// SHARD — WebSocket hook: connection lifecycle, auto-reconnect with
// backoff, and a typed event bus the chat session subscribes to.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, wsEndpoint } from "../lib/endpoints";
import type { WSPacket, WSPacketType } from "../types/protocol";

type PacketHandler = (pkt: WSPacket) => void;
type Status = "connecting" | "open" | "closed";

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8000;

interface UseWebSocketResult {
  /** Sends a packet if the socket is open; returns success. */
  send: (pkt: WSPacket) => boolean;
  /** Bytes queued in the socket but not yet flushed (0 without a socket). */
  bufferedAmount: () => number;
  /** Subscribes to incoming packets; returns an unsubscribe function. */
  on: (handler: PacketHandler) => () => void;
  /** Registers a handler invoked once per fresh (re)connect. */
  onReconnect: (handler: () => void) => () => void;
  /** True once the server answered 404: the room is gone, stop trying. */
  goneRef: React.MutableRefObject<boolean>;
  /** True once the room is known to hold two peers and we are not one. */
  fullRef: React.MutableRefObject<boolean>;
  statusRef: React.RefObject<Status>;
  /** True once a REST probe confirmed the room exists (pre-flight gate). */
  verified: boolean;
  /** Terminal: the two seats are taken and this client is not one of them. */
  roomFull: boolean;
}

export function useWebSocket(roomId: string, enabled: boolean): UseWebSocketResult {
  const wsRef = useRef<WebSocket | null>(null);
  const handlers = useRef(new Set<PacketHandler>());
  const reconnectHandlers = useRef(new Set<() => void>());
  const goneHandlers = useRef(new Set<() => void>());
  const statusRef = useRef<Status>("connecting");
  const goneRef = useRef(false);
  const fullRef = useRef(false);
  /** Set once a REST probe confirmed the room exists (pre-flight gate). */
  const verifiedRef = useRef(false);
  const [verified, setVerified] = useState(false);
  const [roomFull, setRoomFull] = useState(false);
  /** True once THIS client held a seat. A full room is only terminal for a
   *  third party: a peer that has been in and got disconnected must keep
   *  retrying, because the server burns the room on departure. */
  const everOpenedRef = useRef(false);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<number>();
  const closedByUs = useRef(false);

  const notifyGone = useCallback(() => {
    if (goneRef.current) return;
    goneRef.current = true;
    window.clearTimeout(reconnectTimer.current);
    goneHandlers.current.forEach((h) => h());
  }, []);

  /** Terminal state for a rejected third participant: no further network
   *  traffic at all, no reconnect timer, socket closed for good. */
  const notifyFull = useCallback(() => {
    if (fullRef.current) return;
    fullRef.current = true;
    window.clearTimeout(reconnectTimer.current);
    attemptRef.current = 0;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    setRoomFull(true);
  }, []);

  const notifyReconnect = useCallback(() => {
    reconnectHandlers.current.forEach((h) => h());
  }, []);

  /** Cheap REST probe. Returns true for any terminal verdict (room gone, or
   *  full for a client that never held a seat) so the caller stops. */
  const probeRoom = useCallback(async (): Promise<boolean> => {
    if (goneRef.current) return true;
    if (fullRef.current) return true;
    try {
      const res = await fetch(api(`/api/rooms/${encodeURIComponent(roomId)}`));
      if (res.status === 404) {
        notifyGone();
        return true;
      }
      if (res.status === 403) {
        notifyFull();
        return true;
      }
      // The room exists but both seats are taken. A 200 with peerCount 2 is
      // the ONLY signal a third client ever gets: the 403 on the socket
      // upgrade is invisible to the WebSocket API (the browser reports an
      // abnormal close, code 1006). Without this check the pre-flight gate
      // waves the third visitor through, the chat shell flashes, the upgrade
      // is refused, and the retry loop renders that flash forever.
      if (!everOpenedRef.current && res.ok) {
        const body = (await res.json().catch(() => null)) as { peerCount?: number } | null;
        if (typeof body?.peerCount === "number" && body.peerCount >= 2) {
          notifyFull();
          return true;
        }
      }
    } catch {
      /* server unreachable: treat as "still waiting", keep looping */
    }
    return false;
  }, [roomId, notifyGone, notifyFull]);

  const openSocket = useCallback(() => {
    if (!enabled || closedByUs.current || goneRef.current || fullRef.current) return;
    const ws = new WebSocket(wsEndpoint(roomId));
    wsRef.current = ws;
    statusRef.current = "connecting";

    ws.onopen = () => {
      if (wsRef.current !== ws) return; // stale socket from a previous mount
      statusRef.current = "open";
      attemptRef.current = 0;
      everOpenedRef.current = true;
      notifyReconnect();
    };
    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return;
      try {
        const pkt = JSON.parse(e.data) as WSPacket;
        handlers.current.forEach((h) => h(pkt));
      } catch {
        // blind relay noise or malformed frame: ignore.
      }
    };
    ws.onclose = () => {
      // StrictMode double-mount guard: ignore stale sockets from previous
      // effect runs, otherwise their onclose schedules phantom reconnects
      // that fill the 2-seat room with duplicates of the same client.
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      const neverOpened = statusRef.current === "connecting";
      statusRef.current = "closed";
      if (closedByUs.current || !enabled || goneRef.current || fullRef.current) return;
      if (neverOpened) {
        // The upgrade was refused (a full room answers 403 before the
        // handshake). Drop the verified mark so the next attempt re-probes:
        // the probe is what tells a full room apart from a network blip, and
        // it ends the loop within one cycle instead of flashing the chat.
        verifiedRef.current = false;
        setVerified(false);
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (wsRef.current === ws) ws.close();
    };
  }, [roomId, enabled, notifyReconnect]);

  const connect = useCallback(() => {
    if (!enabled || closedByUs.current || goneRef.current || fullRef.current) return;
    // re-flight gate: never open a socket for a room that does not exist.
    // dead /room/:id link must land on the destroyed screen immediately —
    // the chat UI must not flash for a second before the 404 arrives.
    if (!verifiedRef.current) {
      void probeRoom().then((terminal) => {
        // Re-check verified: StrictMode double-mounts run two probes in
        // light; only the first resolution may open the socket, the
        // second would create a phantom duplicate connection.
        if (closedByUs.current || goneRef.current || fullRef.current || terminal || verifiedRef.current) return;
        verifiedRef.current = true;
        setVerified(true);
        openSocket();
      });
      return;
    }
    openSocket();
  }, [enabled, probeRoom, openSocket]);

  function scheduleReconnect() {
    if (goneRef.current || fullRef.current || closedByUs.current) return;
    // Exponential backoff - the room may simply be waiting for its peer.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptRef.current, RECONNECT_MAX_MS);
    attemptRef.current += 1;
    reconnectTimer.current = window.setTimeout(connect, delay);
  }

  useEffect(() => {
    closedByUs.current = false;
    connect();
    return () => {
      closedByUs.current = true;
      verifiedRef.current = false;
      setVerified(false);
      window.clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      if (!ws) return;
      const kill = () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
      // Closing a CONNECTING socket aborts Vite's WS proxy (ECONNABORTED)
      // and shows WebSocket is closed before the connection is established.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", kill);
        if (ws.readyState !== WebSocket.CONNECTING) kill();
        return;
      }
      kill();
    };
  }, [connect]);

  // Periodic safety net: if the room vanished mid-session (server restart),
  // background probe flips the UI to "gone" even when the WS stays silent.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (statusRef.current !== "open" && !goneRef.current && !fullRef.current) void probeRoom();
    }, 5000);
    return () => window.clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomId]);

  const send = useCallback((pkt: WSPacket) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(pkt));
    return true;
  }, []);

  /** Bytes queued in the socket but not yet flushed — backpressure signal
   *  for the chunked file sender. 0 when no socket is open. */
  const bufferedAmount = useCallback(() => wsRef.current?.bufferedAmount ?? 0, []);

  const on = useCallback((handler: PacketHandler) => {
    handlers.current.add(handler);
    return () => handlers.current.delete(handler);
  }, []);

  const onReconnect = useCallback((handler: () => void) => {
    reconnectHandlers.current.add(handler);
    return () => reconnectHandlers.current.delete(handler);
  }, []);

  return { send, on, onReconnect, goneRef, fullRef, statusRef, verified, roomFull, bufferedAmount };
}

export type { Status as WsStatus };
export type { WSPacketType };
