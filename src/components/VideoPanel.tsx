import { useEffect, useRef } from "react";

interface VideoPanelProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
}

export function VideoPanel({ stream, label, muted = false }: VideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="flex flex-col h-full bg-zinc-900 rounded-xl overflow-hidden shadow-2xl border border-zinc-800">
      {/* Drag handle bar */}
      <div className="drag-handle flex items-center gap-2 px-3 py-1.5 bg-zinc-800/80 cursor-grab active:cursor-grabbing select-none shrink-0">
        <svg
          className="w-3 h-3 text-zinc-500"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
        <span className="text-xs text-zinc-400 font-medium">{label}</span>
      </div>

      {/* Video */}
      <div className="relative flex-1 min-h-0 bg-zinc-900">
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            className={`w-full h-full object-cover ${muted ? "scale-x-[-1]" : ""}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center text-zinc-600">
              <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-2">
                <svg
                  className="w-6 h-6 text-zinc-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                  />
                </svg>
              </div>
              <p className="text-xs">
                {label === "You" ? "Starting camera…" : "Waiting for guest…"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
