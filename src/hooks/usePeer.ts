import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";

/**
 * usePeer — manages the full WebRTC lifecycle for a two-person session.
 *
 * ## Roles
 * - **Host**: registers a named PeerJS peer using `roomCode.toLowerCase()` as the peer ID,
 *   then waits for an incoming connection and media call.
 * - **Guest**: connects to that peer ID, opens a data channel, and initiates the media call.
 *
 * ## What it owns
 * - `localStream` → sent to the remote peer via `peer.call()`
 * - Incoming media stream → exposed as `remoteStream`
 * - Data channel (`DataConnection`) → passed out so callers can send/receive structured messages
 *
 * ## Teardown
 * The effect cleanup closes the call, data connection, and destroys the Peer instance
 * when the component unmounts or when `localStream` / `roomCode` changes.
 */

/** Connection lifecycle stages shown in the UI status badge. */
export type PeerStatus =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "error";

interface UsePeerOptions {
  roomCode: string;
  isHost: boolean;
  localStream: MediaStream | null;
}

interface UsePeerResult {
  remoteStream: MediaStream | null;
  dataConnection: DataConnection | null;
  status: PeerStatus;
  error: string | null;
}

export function usePeer({
  roomCode,
  isHost,
  localStream,
}: UsePeerOptions): UsePeerResult {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [dataConnection, setDataConnection] = useState<DataConnection | null>(
    null,
  );
  const [status, setStatus] = useState<PeerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const dataConnRef = useRef<DataConnection | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signalingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const connectToHostRef = useRef<() => void>(() => undefined);

  const scheduleReconnect = useCallback(() => {
    if (isHost || !mountedRef.current || reconnectTimerRef.current) return;

    setStatus("connecting");
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectToHostRef.current();
    }, 1_500);
  }, [isHost]);

  const setupDataConn = useCallback((conn: DataConnection) => {
    const previous = dataConnRef.current;
    dataConnRef.current = conn;
    if (previous && previous !== conn) previous.close();

    conn.on("open", () => {
      if (dataConnRef.current !== conn) return;
      setDataConnection(conn);
      setStatus("connected");
      setError(null);
    });
    conn.on("close", () => {
      if (dataConnRef.current !== conn) return;
      dataConnRef.current = null;
      setDataConnection(null);
      if (isHost) setStatus("waiting");
      else scheduleReconnect();
    });
    conn.on("error", (err) => {
      if (dataConnRef.current !== conn) return;
      setError(err.message);
      if (!isHost) scheduleReconnect();
    });
  }, [isHost, scheduleReconnect]);

  const setupCall = useCallback(
    (call: MediaConnection) => {
      const previous = callRef.current;
      callRef.current = call;
      if (previous && previous !== call) previous.close();

      call.on("stream", (remoteMediaStream) => {
        if (callRef.current !== call) return;
        setRemoteStream(remoteMediaStream);
      });
      call.on("close", () => {
        if (callRef.current !== call) return;
        callRef.current = null;
        setRemoteStream(null);
        if (!isHost) scheduleReconnect();
      });
      call.on("error", () => {
        if (callRef.current === call && !isHost) scheduleReconnect();
      });
    },
    [isHost, scheduleReconnect],
  );

  useEffect(() => {
    if (!localStream) return;

    mountedRef.current = true;
    const peerId = isHost ? roomCode.toLowerCase() : undefined;
    const peer = new Peer(peerId as string, {
      debug: 0,
      config: {
        // Multiple STUN servers improve NAT traversal reliability across networks.
        // For production use on cellular (carrier-grade NAT / symmetric NAT), you
        // will also need TURN servers — add them here with credentials:
        // { urls: "turn:your-turn-server.example.com", username: "…", credential: "…" }
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
        ],
        // Unified Plan is the standard SDP format required by modern iOS/Safari.
        sdpSemantics: "unified-plan",
      },
    });
    peerRef.current = peer;
    setStatus("connecting");

    const connectToHost = () => {
      if (!mountedRef.current || peer.destroyed) return;
      if (!peer.open) {
        scheduleReconnect();
        return;
      }

      setStatus("connecting");
      const hostId = roomCode.toLowerCase();
      setupDataConn(peer.connect(hostId, { reliable: true }));
      setupCall(peer.call(hostId, localStream));
    };
    connectToHostRef.current = connectToHost;

    if (isHost) {
      // Register these before "open" so a very fast reconnect cannot arrive
      // between the peer opening and its handlers being attached.
      peer.on("connection", setupDataConn);
      peer.on("call", (call) => {
        call.answer(localStream);
        setupCall(call);
      });
    }

    peer.on("open", () => {
      if (isHost) {
        setStatus("waiting");
      } else {
        connectToHost();
      }
    });

    peer.on("disconnected", () => {
      if (!mountedRef.current || peer.destroyed) return;
      setStatus("connecting");
      // This restores the PeerJS signalling socket. Existing WebRTC channels
      // may survive; if they do not, their close handlers re-dial the host.
      if (signalingTimerRef.current) clearTimeout(signalingTimerRef.current);
      signalingTimerRef.current = setTimeout(() => {
        signalingTimerRef.current = null;
        if (mountedRef.current && !peer.destroyed && peer.disconnected) {
          peer.reconnect();
        }
      }, 1_000);
    });

    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        setError(
          "This session code is already in use. Please try starting a new session.",
        );
      } else if (err.type === "peer-unavailable") {
        // The host may only be offline briefly. Keep retrying with the same
        // guest peer so a refresh or network handover can recover.
        setError("Waiting for the session host to reconnect…");
        scheduleReconnect();
        return;
      } else {
        setError(`Connection error: ${err.message}`);
      }
      setStatus("error");
    });

    return () => {
      mountedRef.current = false;
      connectToHostRef.current = () => undefined;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (signalingTimerRef.current) {
        clearTimeout(signalingTimerRef.current);
        signalingTimerRef.current = null;
      }
      callRef.current?.close();
      dataConnRef.current?.close();
      callRef.current = null;
      dataConnRef.current = null;
      peer.destroy();
      peerRef.current = null;
    };
  }, [
    localStream,
    roomCode,
    isHost,
    setupDataConn,
    setupCall,
    scheduleReconnect,
  ]);

  return { remoteStream, dataConnection, status, error };
}
