import { useState, useEffect } from "react";

import { VideoGrid } from "../components/VideoGrid";
import { YoutubeWidget } from "../components/YoutubeWidget";
import { usePeer } from "../hooks/usePeer";

interface SessionProps {
  roomCode: string;
  isHost: boolean;
}

export function Session({ roomCode, isHost }: SessionProps) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const { remoteStream, dataConnection, status, error } = usePeer({
    roomCode,
    isHost,
    localStream,
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
    <div className="relative min-h-screen bg-zinc-950 flex flex-col p-4 gap-4">
      {/* Top bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold text-lg tracking-tight">
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
        <div className="bg-red-950/60 border border-red-700 rounded-xl px-4 py-2.5 text-red-300 text-sm shrink-0">
          {error}
        </div>
      )}

      {/* Video area */}
      <div className="flex-1 min-h-0">
        <VideoGrid localStream={localStream} remoteStream={remoteStream} />
      </div>

      {/* Floating YouTube widget — rendered inside the relative container */}
      <YoutubeWidget dataConnection={dataConnection} />
    </div>
  );
}
