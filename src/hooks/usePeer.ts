import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";

export type PeerStatus = "idle" | "connecting" | "waiting" | "connected" | "error";

export interface RemotePeerStream {
  peerId: string;
  stream: MediaStream;
}

/**
 * A stable, DataConnection-compatible facade over every connection in the
 * room. Existing sync hooks can listen once and broadcast without knowing
 * whether the room currently contains one, two, or three remote peers.
 */
export interface RoomDataConnection {
  readonly open: boolean;
  readonly dataChannel?: RTCDataChannel;
  on(event: "data", listener: (data: unknown) => void): void;
  off(event: "data", listener: (data: unknown) => void): void;
  send(data: unknown): void;
}

class MeshDataConnection implements RoomDataConnection {
  private connections = new Map<string, DataConnection>();
  private listeners = new Set<(data: unknown) => void>();
  private localPeerId = "";
  private seenMessages = new Set<string>();

  configure(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  get open() {
    return [...this.connections.values()].some(connection => connection.open);
  }

  get dataChannel() {
    return [...this.connections.values()].find(connection => connection.open)?.dataChannel;
  }

  on(_event: "data", listener: (data: unknown) => void) {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (data: unknown) => void) {
    this.listeners.delete(listener);
  }

  emit(data: unknown) {
    this.listeners.forEach(listener => listener(data));
  }

  accept(messageId: string) {
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.add(messageId);
    if (this.seenMessages.size > 2_000) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }
    return true;
  }

  relay(message: MeshMessage, exceptPeerId: string) {
    for (const [peerId, connection] of this.connections) {
      if (peerId !== exceptPeerId && connection.open) connection.send(message);
    }
  }

  add(connection: DataConnection) {
    this.connections.set(connection.peer, connection);
  }

  remove(peerId: string, connection: DataConnection) {
    if (this.connections.get(peerId) === connection) this.connections.delete(peerId);
  }

  has(peerId: string) {
    return this.connections.get(peerId)?.open ?? false;
  }

  peers() {
    return [...this.connections.entries()]
      .filter(([, connection]) => connection.open)
      .map(([peerId]) => peerId);
  }

  send(data: unknown) {
    if (typeof data !== "object" || data === null) return;
    const message = {
      ...data,
      __meshMessageId: crypto.randomUUID(),
      __meshSourcePeerId: this.localPeerId,
    } as MeshMessage;
    this.accept(message.__meshMessageId);
    for (const connection of this.connections.values()) {
      if (connection.open) connection.send(message);
    }
  }

  closeAll() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    connections.forEach(connection => connection.close());
  }
}

interface UsePeerOptions {
  roomCode: string;
  isHost: boolean;
  localStream: MediaStream | null;
}

interface UsePeerResult {
  remoteStreams: RemotePeerStream[];
  dataConnection: RoomDataConnection | null;
  participantCount: number;
  status: PeerStatus;
  error: string | null;
  replaceVideoTrack: (track: MediaStreamTrack | null) => Promise<void>;
}

type RoomRole = "owner" | "joiner";
type MeshControl =
  | { __watchTogether: "roster"; peers: string[] }
  | { __watchTogether: "room-full" }
  | { __watchTogether: "ping"; nonce: string }
  | { __watchTogether: "pong"; nonce: string };

type MeshMessage = {
  __meshMessageId: string;
  __meshSourcePeerId: string;
} & Record<string, unknown>;

const MAX_PARTICIPANTS = 4;

function isMeshControl(data: unknown): data is MeshControl {
  return (
    typeof data === "object" &&
    data !== null &&
    "__watchTogether" in data
  );
}

function isMeshMessage(data: unknown): data is MeshMessage {
  return typeof data === "object" && data !== null && "__meshMessageId" in data && typeof data.__meshMessageId === "string" && "__meshSourcePeerId" in data && typeof data.__meshSourcePeerId === "string";
}

function identifyPeerMessage(
  data: unknown,
  sourcePeerId: string,
  localPeerId: string,
): unknown {
  if (typeof data !== "object" || data === null || !("id" in data)) return data;
  const message = data as { id?: unknown };
  if (message.id === "local") {
    return { ...data, id: `remote-peer:${sourcePeerId}` };
  }
  if (
    typeof message.id === "string" &&
    message.id === `remote-peer:${localPeerId}`
  ) {
    return { ...data, id: "local" };
  }
  return data;
}

function configuredIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ];
  const urls = import.meta.env.VITE_TURN_URLS?.split(",")
    .map((url: string) => url.trim())
    .filter(Boolean);
  const username = import.meta.env.VITE_TURN_USERNAME?.trim();
  const credential = import.meta.env.VITE_TURN_CREDENTIAL?.trim();
  if (urls?.length && username && credential) {
    servers.push({ urls, username, credential });
  }
  return servers;
}

const peerOptions: NonNullable<ConstructorParameters<typeof Peer>[1]> = {
  debug: 0,
  config: {
    iceServers: configuredIceServers(),
    iceCandidatePoolSize: 10,
    iceTransportPolicy: "all",
    sdpSemantics: "unified-plan",
  },
};

export function usePeer({
  roomCode,
  isHost,
  localStream,
}: UsePeerOptions): UsePeerResult {
  const [remoteStreams, setRemoteStreams] = useState<RemotePeerStream[]>([]);
  const [dataConnection, setDataConnection] = useState<RoomDataConnection | null>(null);
  const [participantCount, setParticipantCount] = useState(1);
  const [status, setStatus] = useState<PeerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const meshRef = useRef(new MeshDataConnection());
  const callsRef = useRef<Map<string, MediaConnection>>(new Map());
  const videoSendersRef = useRef<Set<RTCRtpSender>>(new Set());

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const replacements: Promise<void>[] = [];
    for (const call of callsRef.current.values()) {
      const sender = call.peerConnection.getSenders().find(candidate => candidate.track?.kind === "video" || videoSendersRef.current.has(candidate));
      if (sender) videoSendersRef.current.add(sender);
      if (sender) replacements.push(sender.replaceTrack(track));
      else if (track) call.close();
    }
    await Promise.all(replacements);
  }, []);

  useEffect(() => {
    if (!localStream) return;

    let active = true;
    let role: RoomRole = isHost ? "owner" : "joiner";
    let roomFull = false;
    let transitionTimer: ReturnType<typeof setTimeout> | null = null;
    let signalingTimer: ReturnType<typeof setTimeout> | null = null;
    const roomId = roomCode.toLowerCase();
    const mesh = meshRef.current;
    const dataConnections = new Map<string, DataConnection>();
    const calls = new Map<string, MediaConnection>();
    callsRef.current = calls;
    const mediaRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const streams = new Map<string, MediaStream>();

    const publishStreams = () => {
      setRemoteStreams(
        [...streams.entries()].map(([peerId, stream]) => ({ peerId, stream })),
      );
    };

    const publishConnectionState = () => {
      setParticipantCount(mesh.peers().length + 1);
      if (mesh.open) {
        setDataConnection(mesh);
        setStatus("connected");
        setError(null);
      } else {
        setDataConnection(null);
        setStatus(role === "owner" ? "waiting" : "connecting");
      }
    };

    const clearTransition = () => {
      if (transitionTimer) clearTimeout(transitionTimer);
      transitionTimer = null;
    };

    const clearMesh = () => {
      dataConnections.clear();
      mesh.closeAll();
      for (const call of calls.values()) call.close();
      calls.clear();
      mediaRetryTimers.forEach(clearTimeout);
      mediaRetryTimers.clear();
      streams.clear();
      setRemoteStreams([]);
      setDataConnection(null);
      setParticipantCount(1);
    };

    const broadcastRoster = (peer: Peer) => {
      if (role !== "owner" || !peer.open) return;
      const peers = [peer.id, ...mesh.peers()].slice(0, MAX_PARTICIPANTS);
      for (const connection of dataConnections.values()) {
        if (connection.open) {
          connection.send({ __watchTogether: "roster", peers } satisfies MeshControl);
        }
      }
    };

    const shouldInitiateCall = (peer: Peer, targetId: string) =>
      peer.id.localeCompare(targetId) > 0 && localStream.getTracks().length > 0;

    const scheduleCall = (peer: Peer, targetId: string, delay = 120) => {
      if (!active || calls.has(targetId) || mediaRetryTimers.has(targetId)) return;
      const timer = setTimeout(() => {
        mediaRetryTimers.delete(targetId);
        if (active && mesh.has(targetId) && shouldInitiateCall(peer, targetId)) callPeer(peer, targetId);
      }, delay);
      mediaRetryTimers.set(targetId, timer);
    };

    const setupCall = (peer: Peer, call: MediaConnection) => {
      const previous = calls.get(call.peer);
      calls.set(call.peer, call);
      if (previous && previous !== call) previous.close();

      call.on("stream", stream => {
        if (!active || calls.get(call.peer) !== call) return;
        streams.set(call.peer, stream);
        publishStreams();
      });
      call.on("close", () => {
        if (!active || calls.get(call.peer) !== call) return;
        calls.delete(call.peer);
        streams.delete(call.peer);
        publishStreams();
        scheduleCall(peer, call.peer, 350);
      });
      call.on("error", () => {
        if (calls.get(call.peer) === call) {
          calls.delete(call.peer);
          streams.delete(call.peer);
          publishStreams();
          scheduleCall(peer, call.peer, 350);
        }
      });
    };

    const callPeer = (peer: Peer, targetId: string) => {
      if (calls.has(targetId) || localStream.getTracks().length === 0) return;
      setupCall(peer, peer.call(targetId, localStream));
    };

    const dialMeshPeer = (peer: Peer, targetId: string) => {
      if (
        !active ||
        targetId === peer.id ||
        mesh.has(targetId) ||
        dataConnections.has(targetId)
      )
        return;
      setupDataConnection(
        peer,
        peer.connect(targetId, {
          reliable: true,
          metadata: { canSendMedia: localStream.getTracks().length > 0 },
        }),
      );
    };

    const handleRoster = (peer: Peer, peers: string[]) => {
      const members = peers.slice(0, MAX_PARTICIPANTS);
      for (const targetId of members) {
        if (targetId === peer.id || targetId === roomId) continue;
        // Exactly one side initiates each non-owner mesh edge.
        if (peer.id.localeCompare(targetId) > 0) dialMeshPeer(peer, targetId);
      }
    };

    function setupDataConnection(peer: Peer, connection: DataConnection) {
      const existing = dataConnections.get(connection.peer);
      if (existing && existing !== connection) {
        connection.close();
        return;
      }
      dataConnections.set(connection.peer, connection);
      let lastSeenAt = Date.now();
      let heartbeatConfirmed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      connection.on("open", () => {
        if (!active || dataConnections.get(connection.peer) !== connection) return;

        if (
          role === "owner" &&
          !mesh.has(connection.peer) &&
          mesh.peers().length >= MAX_PARTICIPANTS - 1
        ) {
          connection.send({ __watchTogether: "room-full" } satisfies MeshControl);
          connection.close();
          return;
        }

        mesh.add(connection);
        lastSeenAt = Date.now();
        heartbeat = setInterval(() => {
          if (heartbeatConfirmed && Date.now() - lastSeenAt > 6_000) {
            connection.close();
            return;
          }
          try {
            connection.send({ __watchTogether: "ping", nonce: crypto.randomUUID() } satisfies MeshControl);
          } catch {
            connection.close();
          }
        }, 2_000);
        clearTransition();
        publishConnectionState();
        if (role === "owner") broadcastRoster(peer);

        const remoteCanSendMedia =
          (connection.metadata as { canSendMedia?: boolean } | undefined)
            ?.canSendMedia ?? true;
        if (!remoteCanSendMedia && localStream!.getTracks().length > 0) callPeer(peer, connection.peer);
        else scheduleCall(peer, connection.peer);
      });

      connection.on("data", raw => {
        if (!active || dataConnections.get(connection.peer) !== connection) return;
        lastSeenAt = Date.now();
        if (isMeshMessage(raw)) {
          if (!mesh.accept(raw.__meshMessageId)) return;
          mesh.relay(raw, connection.peer);
          mesh.emit(identifyPeerMessage(raw, raw.__meshSourcePeerId, peer.id));
          return;
        }
        if (isMeshControl(raw)) {
          if (raw.__watchTogether === "roster") handleRoster(peer, raw.peers);
          if (raw.__watchTogether === "room-full") {
            roomFull = true;
            setError("This room is full (maximum 4 people).");
            setStatus("error");
          }
          if (raw.__watchTogether === "ping") connection.send({ __watchTogether: "pong", nonce: raw.nonce } satisfies MeshControl);
          if (raw.__watchTogether === "pong") heartbeatConfirmed = true;
          return;
        }
        mesh.emit(identifyPeerMessage(raw, connection.peer, peer.id));
      });

      const remove = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!active || dataConnections.get(connection.peer) !== connection) return;
        dataConnections.delete(connection.peer);
        mesh.remove(connection.peer, connection);
        const call = calls.get(connection.peer);
        calls.delete(connection.peer);
        call?.close();
        streams.delete(connection.peer);
        publishStreams();
        if (roomFull) return;
        publishConnectionState();
        if (role === "owner") broadcastRoster(peer);
        else if (connection.peer === roomId) recoverRoom();
      };
      connection.on("close", remove);
      connection.on("error", remove);
    }

    const dialOwner = (peer: Peer) => {
      if (!active || peerRef.current !== peer || !peer.open) return;
      setStatus("connecting");
      dialMeshPeer(peer, roomId);
    };

    const createPeer = (nextRole: RoomRole) => {
      if (!active) return;
      clearTransition();
      role = nextRole;
      clearMesh();
      peerRef.current?.destroy();

      const peer =
        nextRole === "owner" ? new Peer(roomId, peerOptions) : new Peer(peerOptions);
      peerRef.current = peer;
      setStatus("connecting");

      peer.on("connection", connection => setupDataConnection(peer, connection));
      peer.on("call", call => {
        // The owner rejects unsolicited fifth-member media calls.
        if (
          role === "owner" &&
          !dataConnections.has(call.peer) &&
          mesh.peers().length >= MAX_PARTICIPANTS - 1
        ) {
          call.close();
          return;
        }
        call.answer(localStream);
        setupCall(peer, call);
      });

      peer.on("open", () => {
        if (!active || peerRef.current !== peer) return;
        setError(null);
        mesh.configure(peer.id);
        if (role === "owner") setStatus("waiting");
        else dialOwner(peer);
      });

      peer.on("disconnected", () => {
        if (!active || peerRef.current !== peer || peer.destroyed) return;
        setStatus("connecting");
        if (signalingTimer) clearTimeout(signalingTimer);
        signalingTimer = setTimeout(() => {
          signalingTimer = null;
          if (active && peerRef.current === peer && !peer.destroyed && peer.disconnected) {
            peer.reconnect();
          }
        }, 1_000);
      });

      peer.on("error", peerError => {
        if (!active || peerRef.current !== peer) return;
        if (peerError.type === "unavailable-id" && role === "owner") {
          if (!transitionTimer) {
            transitionTimer = setTimeout(() => createPeer("joiner"), 300);
          }
          return;
        }
        if (peerError.type === "peer-unavailable" && role === "joiner") {
          if (!transitionTimer) {
            setError("Restoring the session…");
            transitionTimer = setTimeout(() => createPeer("owner"), 500);
          }
          return;
        }
        setError(`Connection error: ${peerError.message}`);
        setStatus("error");
      });
    };

    function recoverRoom() {
      if (!active || role === "owner" || transitionTimer) return;
      setStatus("connecting");
      setError("Restoring the session…");
      transitionTimer = setTimeout(() => createPeer("owner"), 500);
    }

    createPeer(role);

    return () => {
      active = false;
      clearTransition();
      if (signalingTimer) clearTimeout(signalingTimer);
      clearMesh();
      if (callsRef.current === calls) callsRef.current = new Map();
      peerRef.current?.destroy();
      peerRef.current = null;
    };
  }, [localStream, roomCode, isHost]);

  return { remoteStreams, dataConnection, participantCount, status, error, replaceVideoTrack };
}
