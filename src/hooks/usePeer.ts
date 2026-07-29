import { useState, useEffect, useRef } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";

/**
 * Manages a two-person PeerJS room whose ownership can move between clients.
 *
 * The client that owns `roomCode` accepts incoming connections. The other
 * client has an anonymous PeerJS ID and dials the room owner. If the owner
 * leaves, the remaining client claims `roomCode`; if the old owner returns, it
 * sees that the ID is taken and automatically becomes the joining client.
 */

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

type RoomRole = "owner" | "joiner";

const peerOptions: NonNullable<ConstructorParameters<typeof Peer>[1]> = {
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ],
    sdpSemantics: "unified-plan",
  },
};

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

  useEffect(() => {
    if (!localStream) return;

    let active = true;
    let role: RoomRole = isHost ? "owner" : "joiner";
    let transitionTimer: ReturnType<typeof setTimeout> | null = null;
    let signalingTimer: ReturnType<typeof setTimeout> | null = null;
    const roomId = roomCode.toLowerCase();

    const clearTransitionTimer = () => {
      if (!transitionTimer) return;
      clearTimeout(transitionTimer);
      transitionTimer = null;
    };

    const clearConnections = () => {
      const call = callRef.current;
      const data = dataConnRef.current;
      callRef.current = null;
      dataConnRef.current = null;
      call?.close();
      data?.close();
      setRemoteStream(null);
      setDataConnection(null);
    };

    const setupDataConnection = (conn: DataConnection) => {
      const previous = dataConnRef.current;
      dataConnRef.current = conn;
      if (previous && previous !== conn) previous.close();

      conn.on("open", () => {
        if (!active || dataConnRef.current !== conn) return;
        clearTransitionTimer();
        setDataConnection(conn);
        setStatus("connected");
        setError(null);
      });

      conn.on("close", () => {
        if (!active || dataConnRef.current !== conn) return;
        dataConnRef.current = null;
        setDataConnection(null);
        recoverRoom();
      });

      conn.on("error", () => {
        if (!active || dataConnRef.current !== conn) return;
        recoverRoom();
      });
    };

    const setupCall = (call: MediaConnection) => {
      const previous = callRef.current;
      callRef.current = call;
      if (previous && previous !== call) previous.close();

      call.on("stream", (stream) => {
        if (active && callRef.current === call) setRemoteStream(stream);
      });

      call.on("close", () => {
        if (!active || callRef.current !== call) return;
        callRef.current = null;
        setRemoteStream(null);
        recoverRoom();
      });

      call.on("error", () => {
        if (active && callRef.current === call) recoverRoom();
      });
    };

    const dialOwner = (peer: Peer) => {
      if (!active || peerRef.current !== peer || !peer.open) return;
      setStatus("connecting");
      const canSendMedia = localStream.getTracks().length > 0;
      setupDataConnection(
        peer.connect(roomId, {
          reliable: true,
          metadata: { canSendMedia },
        }),
      );
      // An empty-stream joiner must not create the offer: an offer without
      // media sections cannot receive tracks. The owner calls it instead.
      if (canSendMedia) setupCall(peer.call(roomId, localStream));
    };

    const createPeer = (nextRole: RoomRole) => {
      if (!active) return;

      clearTransitionTimer();
      role = nextRole;
      clearConnections();

      const previous = peerRef.current;
      peerRef.current = null;
      previous?.destroy();

      const peer =
        nextRole === "owner"
          ? new Peer(roomId, peerOptions)
          : new Peer(peerOptions);
      peerRef.current = peer;
      setStatus("connecting");

      if (nextRole === "owner") {
        peer.on("connection", (conn) => {
          setupDataConnection(conn);
          const remoteCanSendMedia =
            (conn.metadata as { canSendMedia?: boolean } | undefined)
              ?.canSendMedia ?? true;
          if (!remoteCanSendMedia && localStream.getTracks().length > 0) {
            setupCall(peer.call(conn.peer, localStream));
          }
        });
      }
      // Either role may receive the media call. In particular, an owner with
      // media calls a receive-only joiner after inspecting its data metadata.
      peer.on("call", (call) => {
        call.answer(localStream);
        setupCall(call);
      });

      peer.on("open", () => {
        if (!active || peerRef.current !== peer) return;
        setError(null);
        if (role === "owner") setStatus("waiting");
        else dialOwner(peer);
      });

      peer.on("disconnected", () => {
        if (!active || peerRef.current !== peer || peer.destroyed) return;
        setStatus("connecting");
        if (signalingTimer) clearTimeout(signalingTimer);
        signalingTimer = setTimeout(() => {
          signalingTimer = null;
          if (
            active &&
            peerRef.current === peer &&
            !peer.destroyed &&
            peer.disconnected
          ) {
            peer.reconnect();
          }
        }, 1_000);
      });

      peer.on("error", (peerError) => {
        if (!active || peerRef.current !== peer) return;

        if (peerError.type === "unavailable-id" && role === "owner") {
          // Another surviving participant owns the room, so join it.
          if (transitionTimer) return;
          setError(null);
          transitionTimer = setTimeout(() => createPeer("joiner"), 300);
          return;
        }

        if (peerError.type === "peer-unavailable" && role === "joiner") {
          // Nobody currently owns the room. Claim it so future clients can
          // reconnect to this participant.
          if (transitionTimer) return;
          setError("Restoring the session…");
          transitionTimer = setTimeout(() => createPeer("owner"), 500);
          return;
        }

        setError(`Connection error: ${peerError.message}`);
        setStatus("error");
      });
    };

    function recoverRoom() {
      if (!active || transitionTimer) return;

      if (role === "owner") {
        // The room address is still ours; wait for the other participant.
        setStatus("waiting");
        return;
      }

      // A joiner left alone becomes the new owner of the stable room address.
      setStatus("connecting");
      setError("Restoring the session…");
      transitionTimer = setTimeout(() => createPeer("owner"), 500);
    }

    createPeer(role);

    return () => {
      active = false;
      clearTransitionTimer();
      if (signalingTimer) clearTimeout(signalingTimer);
      clearConnections();
      peerRef.current?.destroy();
      peerRef.current = null;
    };
  }, [localStream, roomCode, isHost]);

  return { remoteStream, dataConnection, status, error };
}
