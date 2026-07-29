import { useState, useRef, useCallback, useEffect } from "react";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import { useYouTubePlayer } from "../hooks/useYouTubePlayer";
import { DockButton } from "./Dock";
import type { DataConnection } from "peerjs";

/**
 * YoutubeWidget — YouTube player with URL input and bidirectional sync.
 *
 * ## Sync flow (outbound)
 * User actions (play/pause/seek) → `handleStateChange` → `sendSync`
 *
 * ## Sync flow (inbound)
 * Remote message → `handleRemoteSync` → `seekTo` + `playVideo`/`pauseVideo`
 *
 * ## Echo prevention
 * Calling `seekTo()` and then `playVideo()` causes the YT IFrame API to fire
 * `onStateChange` events, which would echo back to the remote peer. A
 * timestamp-based guard (`syncUntilRef`) suppresses all state events for 500 ms
 * after any remote-triggered command, regardless of how many intermediate
 * states (buffering, seeking) the player emits before settling.
 */

interface YoutubeWidgetProps {
  dataConnection: DataConnection | null;
  initialVideoId?: string;
  onClose?: () => void;
  /** 0–1 spatial volume multiplier updated by the parent on every canvas transform change. */
  spatialVolume?: number;
  /** Whether this panel currently has a dock shortcut. */
  docked?: boolean;
  onToggleDock?: () => void;
}

function parseVideoId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("?")[0];
    if (url.searchParams.has("v")) return url.searchParams.get("v");
    const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
  } catch {
    // not a URL — treat as raw ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
  }
  return null;
}

export function YoutubeWidget({
  dataConnection,
  initialVideoId,
  onClose,
  spatialVolume = 1,
  docked = false,
  onToggleDock,
}: YoutubeWidgetProps) {
  const [hasVideo, setHasVideo] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [minimised, setMinimised] = useState(false);
  const [inputError, setInputError] = useState(false);

  // Suppress echoing remote-triggered state changes back to the peer.
  // Set to a future timestamp when a remote sync arrives; all state events
  // fired within that window are ignored, regardless of type.
  const syncUntilRef = useRef<number>(0);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  // sendSync is set below after useYouTubeSync; use a ref to avoid circular deps
  const sendSyncRef = useRef<(msg: SyncMessage) => void>(() => {});

  // Called by useYouTubePlayer when the player's playback state changes
  const handleStateChange = useCallback(
    (state: number, getCurrentTime: () => number) => {
      // Only act on terminal playback states; ignore buffering (3), cued (5), etc.
      if (state !== 1 && state !== 2) return;

      // Suppress all state changes fired within the remote-sync window.
      if (Date.now() < syncUntilRef.current) return;
      const time = getCurrentTime();
      if (state === 1) sendSyncRef.current({ type: "play", time });
      if (state === 2) sendSyncRef.current({ type: "pause", time });
    },
    [],
  );

  const { loadVideo, playVideo, pauseVideo, seekTo, setVolume } =
    useYouTubePlayer(playerContainerRef, { onStateChange: handleStateChange });

  // Keep YouTube player volume in sync with spatial positioning
  useEffect(() => {
    setVolume(spatialVolume * 100);
  }, [spatialVolume, setVolume]);

  // Auto-load if created with an initial video ID (e.g. from a background URL drop)
  useEffect(() => {
    if (initialVideoId) {
      setHasVideo(true);
      loadVideo(initialVideoId);
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemoteSync = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === "load") {
        setHasVideo(true);
        setMinimised(false);
        loadVideo(msg.videoId);
      } else if (msg.type === "play") {
        syncUntilRef.current = Date.now() + 500;
        seekTo(msg.time);
        playVideo();
      } else if (msg.type === "pause") {
        syncUntilRef.current = Date.now() + 500;
        seekTo(msg.time);
        pauseVideo();
      } else if (msg.type === "seek") {
        syncUntilRef.current = Date.now() + 500;
        seekTo(msg.time);
      }
    },
    [loadVideo, playVideo, pauseVideo, seekTo],
  );

  const { sendSync } = useYouTubeSync({
    dataConnection,
    onRemoteSync: handleRemoteSync,
  });
  // Keep sendSyncRef current without re-creating handleStateChange on every render
  sendSyncRef.current = sendSync;

  const handleSubmit = () => {
    const id = parseVideoId(inputValue);
    if (!id) {
      setInputError(true);
      setTimeout(() => setInputError(false), 1500);
      return;
    }
    setHasVideo(true);
    setMinimised(false);
    loadVideo(id);
    sendSync({ type: "load", videoId: id });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const id = parseVideoId(text);
    if (id) {
      e.preventDefault();
      setInputValue(text);
      setHasVideo(true);
      setMinimised(false);
      loadVideo(id);
      sendSync({ type: "load", videoId: id });
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden">
      {/* Header / drag handle */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-red-500"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
          </svg>
          <span className="text-xs font-semibold text-zinc-300">
            Watch Together
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleDock && (
            <DockButton docked={docked} onToggle={onToggleDock} />
          )}
          <button
            onClick={() => setMinimised((m) => !m)}
            className="text-zinc-400 hover:text-white transition-colors"
            aria-label={minimised ? "Expand" : "Minimise"}
          >
            {minimised ? (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 8h16M4 16h16"
                />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 12H4"
                />
              </svg>
            )}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-red-400 transition-colors"
              aria-label="Close"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {!minimised && (
        <>
          {/* URL input */}
          <div className="no-drag px-3 py-2 flex gap-2 shrink-0">
            <div className="relative flex-1 min-w-0">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                placeholder="Paste a YouTube URL…"
                className={`w-full bg-zinc-800 text-zinc-100 text-xs rounded-lg px-3 py-1.5 outline-none border transition-colors placeholder:text-zinc-500 ${
                  inputValue ? "pr-6" : ""
                } ${
                  inputError
                    ? "border-red-500"
                    : "border-zinc-700 focus:border-violet-500"
                }`}
              />
              {inputValue && (
                <button
                  onClick={() => setInputValue("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  aria-label="Clear"
                  tabIndex={-1}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
            <button
              onClick={handleSubmit}
              className="bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
            >
              Load
            </button>
          </div>

          {!hasVideo && (
            <div className="px-3 pb-3 text-center text-zinc-600 text-xs shrink-0">
              Paste a YouTube URL above to watch together
            </div>
          )}
        </>
      )}

      {/*
          Player lives outside the minimised conditional so the YT.Player
          instance is never destroyed when collapsed. Hidden via CSS only.
          `flex-1 min-h-0` lets it fill remaining panel height when visible.
        */}
      <div
        ref={playerContainerRef}
        className={`flex-1 min-h-0 ${!hasVideo || minimised ? "hidden" : ""}`}
      />
    </div>
  );
}
