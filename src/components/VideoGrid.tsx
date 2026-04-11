import { useEffect, useRef } from "react";

interface VideoGridProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

export function VideoGrid({ localStream, remoteStream }: VideoGridProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  return (
    <div className="flex gap-3 w-full h-full">
      <div className="relative flex-1 bg-zinc-900 rounded-xl overflow-hidden">
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover scale-x-[-1]"
        />
        <span className="absolute bottom-2 left-3 text-xs text-white/70 font-medium select-none">
          You
        </span>
      </div>

      <div className="relative flex-1 bg-zinc-900 rounded-xl overflow-hidden">
        {remoteStream ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center text-zinc-500">
              <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                <svg
                  className="w-8 h-8 text-zinc-600"
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
              <p className="text-sm">Waiting for guest…</p>
            </div>
          </div>
        )}
        <span className="absolute bottom-2 left-3 text-xs text-white/70 font-medium select-none">
          {remoteStream ? "Guest" : ""}
        </span>
      </div>
    </div>
  );
}
