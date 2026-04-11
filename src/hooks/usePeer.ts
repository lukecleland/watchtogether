import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";

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

  const setupDataConn = useCallback((conn: DataConnection) => {
    dataConnRef.current = conn;
    conn.on("open", () => {
      setDataConnection(conn);
      setStatus("connected");
    });
    conn.on("close", () => {
      setDataConnection(null);
      setStatus("idle");
    });
    conn.on("error", (err) => {
      setError(err.message);
    });
  }, []);

  const setupCall = useCallback(
    (call: MediaConnection, _stream: MediaStream) => {
      callRef.current = call;
      call.on("stream", (remoteMediaStream) => {
        setRemoteStream(remoteMediaStream);
      });
      call.on("close", () => setRemoteStream(null));
    },
    [],
  );

  useEffect(() => {
    if (!localStream) return;

    const peerId = isHost ? roomCode : undefined;
    const peer = new Peer(peerId as string, {
      debug: 0,
    });
    peerRef.current = peer;
    setStatus("connecting");

    peer.on("open", () => {
      if (isHost) {
        setStatus("waiting");

        peer.on("connection", (conn) => {
          setupDataConn(conn);
        });

        peer.on("call", (call) => {
          call.answer(localStream);
          setupCall(call, localStream);
        });
      } else {
        // Guest: connect data channel then call
        const conn = peer.connect(roomCode, { reliable: true });
        setupDataConn(conn);

        const call = peer.call(roomCode, localStream);
        setupCall(call, localStream);
      }
    });

    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        setError(
          "This session code is already in use. Please try starting a new session.",
        );
      } else if (err.type === "peer-unavailable") {
        setError("Session not found. Check the code and try again.");
      } else {
        setError(`Connection error: ${err.message}`);
      }
      setStatus("error");
    });

    return () => {
      callRef.current?.close();
      dataConnRef.current?.close();
      peer.destroy();
      peerRef.current = null;
    };
  }, [localStream, roomCode, isHost, setupDataConn, setupCall]);

  return { remoteStream, dataConnection, status, error };
}
