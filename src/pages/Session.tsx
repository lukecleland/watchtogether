import { useState, useEffect, useCallback, useRef } from "react";

import { VideoPanel } from "../components/VideoPanel";
import { YoutubeWidget } from "../components/YoutubeWidget";
import { DraggablePanel } from "../components/DraggablePanel";
import { usePeer } from "../hooks/usePeer";
import { useYouTubeSync } from "../hooks/useYouTubeSync";
import type { PanelId, PanelState } from "../types/panels";

interface SessionProps {
  roomCode: string;
  isHost: boolean;
}

function defaultPanels(): Record<PanelId, PanelState> {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const videoW = Math.min(420, Math.floor((vw - 80) / 2));
  const videoH = Math.round((videoW * 9) / 16);
  const topY = 56; // below the top bar
  return {
    // "You" starts on the right, "Guest" on the left.
    // With local↔remote sync swap, both users see their own panel in the same spot.
    local: { x: videoW + 40, y: topY, width: videoW, height: videoH, z: 10 },
    remote: { x: 20, y: topY, width: videoW, height: videoH, z: 10 },
    youtube: { x: vw - 340, y: vh - 280, width: 320, height: 260, z: 20 },
  };
}

export function Session({ roomCode, isHost }: SessionProps) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [panels, setPanels] =
    useState<Record<PanelId, PanelState>>(defaultPanels);
  // Tracks the highest z-index currently in use so we can raise panels on click
  const topZRef = useRef(20);

  const { remoteStream, dataConnection, status, error } = usePeer({
    roomCode,
    isHost,
    localStream,
  });

  // Panel sync — wired to the same data channel as YouTube sync
  const handleRemoteSync = useCallback(
    (msg: { type: string; id?: PanelId; state?: PanelState }) => {
      if (msg.type === "panel-update" && msg.id && msg.state) {
        // Swap local ↔ remote so each user's "You" controls the other's "Guest" and vice versa.
        // YouTube panel is symmetric — no swap needed.
        const targetId: PanelId =
          msg.id === "local"
            ? "remote"
            : msg.id === "remote"
              ? "local"
              : "youtube";
        setPanels((prev) => ({ ...prev, [targetId]: msg.state! }));
      }
      // YouTube-specific messages are handled inside YoutubeWidget via its own useYouTubeSync
    },
    [],
  );

  // We use useYouTubeSync here only to route panel-update messages.
  // YoutubeWidget mounts its own useYouTubeSync instance for YT playback messages.
  const { sendSync } = useYouTubeSync({
    dataConnection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onRemoteSync: handleRemoteSync as any,
  });

  const sendPanelUpdate = useCallback(
    (id: PanelId, state: PanelState) => {
      sendSync({ type: "panel-update", id, state });
    },
    [sendSync],
  );

  const bringToFront = useCallback(
    (id: PanelId) => {
      const nextZ = ++topZRef.current;
      setPanels((prev) => {
        const next = { ...prev, [id]: { ...prev[id], z: nextZ } };
        // Sync immediately so the remote peer sees the z-order change
        sendPanelUpdate(id, next[id]);
        return next;
      });
    },
    [sendPanelUpdate],
  );

  const makePanelHandlers = (id: PanelId) => ({
    onLocalUpdate: (next: PanelState) =>
      setPanels((prev) => ({ ...prev, [id]: next })),
    onSyncUpdate: (next: PanelState) => sendPanelUpdate(id, next),
    onBringToFront: () => bringToFront(id),
  });

  useEffect(() => {
    let stream: MediaStream;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((s) => {
        stream = s;
        setLocalStream(s);
      })
      .catch((err: Error) => {
        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          setMediaError(
            "Camera and microphone access was denied. Please allow access and refresh.",
          );
        } else {
          setMediaError(`Could not access camera/mic: ${err.message}`);
        }
      });

    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const copyCode = () => {
    navigator.clipboard.writeText(window.location.href).catch(() => {
      navigator.clipboard.writeText(roomCode);
    });
  };

  const statusLabel: Record<string, string> = {
    idle: "Setting up…",
    connecting: "Connecting…",
    waiting: "Waiting for guest…",
    connected: "Connected",
    error: "",
  };

  if (mediaError) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
        <div className="bg-red-950/60 border border-red-700 rounded-2xl p-8 max-w-md text-center">
          <p className="text-red-300 font-medium">{mediaError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen bg-zinc-950 overflow-hidden">
      {/* Top bar — fixed overlay, not part of draggable canvas */}
      <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-4 h-12 bg-zinc-950/90 backdrop-blur-sm border-b border-zinc-800/60">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold text-base tracking-tight">
            watchtogether
          </span>
          <span
            className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
              status === "connected"
                ? "bg-emerald-500/20 text-emerald-400"
                : status === "error"
                  ? "bg-red-500/20 text-red-400"
                  : "bg-zinc-700 text-zinc-400"
            }`}
          >
            {error ? "Error" : statusLabel[status]}
          </span>
        </div>

        {isHost && (
          <button
            onClick={copyCode}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs font-mono px-3 py-1.5 rounded-lg transition-colors"
            title="Copy invite link"
          >
            <span>{roomCode}</span>
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="absolute top-14 left-4 right-4 z-50 bg-red-950/60 border border-red-700 rounded-xl px-4 py-2.5 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Free-form panel canvas */}
      <DraggablePanel
        state={panels.local}
        {...makePanelHandlers("local")}
        minWidth={200}
        minHeight={120}
        className="z-10"
      >
        <VideoPanel stream={localStream} label="You" muted />
      </DraggablePanel>

      <DraggablePanel
        state={panels.remote}
        {...makePanelHandlers("remote")}
        minWidth={200}
        minHeight={120}
        className="z-10"
      >
        <VideoPanel stream={remoteStream} label="Guest" />
      </DraggablePanel>

      <DraggablePanel
        state={panels.youtube}
        {...makePanelHandlers("youtube")}
        minWidth={280}
        minHeight={160}
        className="z-20"
      >
        <YoutubeWidget dataConnection={dataConnection} />
      </DraggablePanel>
    </div>
  );
}
