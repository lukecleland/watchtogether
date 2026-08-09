import { useEffect, useRef, useState } from "react";
import { DockButton } from "./Dock";

interface VideoPanelProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  /** Whether this panel currently has a dock shortcut. */
  docked?: boolean;
  onToggleDock?: () => void;
  localControls?: boolean;
  microphoneEnabled?: boolean;
  cameraEnabled?: boolean;
  onToggleMicrophone?: () => void;
  onToggleCamera?: () => void;
}

export function VideoPanel({
  stream,
  label,
  muted = false,
  docked = false,
  onToggleDock,
  localControls = false,
  microphoneEnabled = true,
  cameraEnabled = true,
  onToggleMicrophone,
  onToggleCamera,
}: VideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // iOS Safari refuses to autoplay unmuted video without a user gesture.
  // We start every video element muted (the HTML attribute) so autoplay
  // works, then let the user tap an overlay to unlock audio for remote streams.
  // NOTE: we control video.muted via DOM ref — not JSX prop — because React
  // does not reliably update the muted boolean attribute after mount.
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // `muted` prop being true means "this is always muted" (local / self view).
  // `muted` prop being false means "should play audio" (remote peer).
  const wantsAudio = !muted;
  const showUnlockOverlay = wantsAudio && !audioUnlocked && !!stream;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    // Always start muted so iOS autoplay policy allows the video to play.
    // Audio is unlocked separately via user gesture (see unlockAudio below).
    video.muted = true;
    queueMicrotask(() => setAudioUnlocked(false));
    if (stream) {
      // Explicit play() call — iOS sometimes ignores the autoPlay HTML attribute.
      video.play().catch(() => {
        // Blocked even while muted — extremely restrictive environment.
        // The user can still tap the overlay to start playback.
      });
    }
  }, [stream]);

  const unlockAudio = () => {
    const video = videoRef.current;
    if (!video) return;
    // This runs inside a user-gesture callstack so iOS allows unmuting.
    video.muted = false;
    video.play().catch(() => {});
    setAudioUnlocked(true);
  };

  return (
    <div className="flex flex-col h-full bg-zinc-900 rounded-xl overflow-hidden shadow-2xl border border-zinc-800">
      {/* Drag handle bar */}
      <div className="drag-handle flex items-center justify-between gap-2 px-3 py-1.5 bg-zinc-800/80 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-3 h-3 text-zinc-500 shrink-0"
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
          <span className="text-xs text-zinc-400 font-medium truncate">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {localControls && (
            <>
              <button onClick={onToggleMicrophone} className={`no-drag transition-colors ${microphoneEnabled ? "text-zinc-300 hover:text-white" : "text-red-400 hover:text-red-300"}`} title={microphoneEnabled ? "Mute microphone" : "Unmute microphone"} aria-label={microphoneEnabled ? "Mute microphone" : "Unmute microphone"} aria-pressed={!microphoneEnabled}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={microphoneEnabled ? "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3M9 21h6" : "M4 4l16 16M9 9v3a3 3 0 004.6 2.53M15 10V6a3 3 0 00-5.12-2.12M5 11a7 7 0 0011.1 5.67M19 11a7 7 0 01-.7 3.05M12 18v3M9 21h6"} /></svg>
              </button>
              <button onClick={onToggleCamera} className={`no-drag transition-colors ${cameraEnabled ? "text-zinc-300 hover:text-white" : "text-red-400 hover:text-red-300"}`} title={cameraEnabled ? "Stop camera" : "Start camera"} aria-label={cameraEnabled ? "Stop camera" : "Start camera"} aria-pressed={!cameraEnabled}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d={cameraEnabled ? "M15 10l5-3v10l-5-3v2a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h8a2 2 0 012 2v2z" : "M4 4l16 16M15 10l5-3v10l-3.5-2.1M13 6H5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-1"} /></svg>
              </button>
            </>
          )}
          {onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
        </div>
      </div>

      {/* Video */}
      <div className="relative flex-1 min-h-0 bg-zinc-900">
        {stream ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              // muted is intentionally omitted here — controlled via video.muted
              // DOM property directly because React does not reliably reflect
              // changes to the muted boolean attribute after initial render.
              className={`w-full h-full object-cover ${muted ? "scale-x-[-1]" : ""}`}
            />
            {localControls && !cameraEnabled && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/90 text-xs font-medium text-zinc-400">Camera off</div>
            )}

            {/* iOS audio-unlock overlay — shown for remote streams until tapped */}
            {showUnlockOverlay && (
              <button
                onClick={unlockAudio}
                className="no-drag absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white"
                style={{ touchAction: "manipulation" }}
              >
                <svg
                  className="w-8 h-8 opacity-80"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15.536 8.464a5 5 0 010 7.072M12 6v12m0 0l-3-3m3 3l3-3M9.172 9.172a4 4 0 000 5.656"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19.07 4.929a9 9 0 010 14.142"
                  />
                </svg>
                <span className="text-xs font-medium opacity-90">
                  Tap to hear
                </span>
              </button>
            )}
          </>
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
