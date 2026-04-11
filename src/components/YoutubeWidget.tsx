import { useState, useRef, useCallback } from "react";
import Draggable from "react-draggable";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import { useYouTubePlayer } from "../hooks/useYouTubePlayer";
import type { DataConnection } from "peerjs";

interface YoutubeWidgetProps {
  dataConnection: DataConnection | null;
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

export function YoutubeWidget({ dataConnection }: YoutubeWidgetProps) {
  const [hasVideo, setHasVideo] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [minimised, setMinimised] = useState(false);
  const [inputError, setInputError] = useState(false);

  // isSyncingRef prevents echoing a remote-triggered state change back to the peer
  const isSyncingRef = useRef(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  // sendSync is set below after useYouTubeSync; use a ref to avoid circular deps
  const sendSyncRef = useRef<(msg: SyncMessage) => void>(() => {});

  // Called by useYouTubePlayer when the player's playback state changes
  const handleStateChange = useCallback(
    (state: number, getCurrentTime: () => number) => {
      const stateNames: Record<number, string> = {
        "-1": "unstarted",
        0: "ended",
        1: "playing",
        2: "paused",
        3: "buffering",
        5: "cued",
      };
      console.log(
        `[YT] onStateChange state=${state} (${stateNames[state] ?? "?"}) isSyncing=${isSyncingRef.current}`,
      );

      // Only act on terminal playback states; ignore buffering (3), cued (5), etc.
      if (state !== 1 && state !== 2) {
        console.log(`[YT] ignoring intermediate state ${state}`);
        return;
      }

      if (isSyncingRef.current) {
        console.log(
          `[YT] isSyncing=true → suppressing broadcast, clearing flag`,
        );
        isSyncingRef.current = false;
        return;
      }
      const time = getCurrentTime();
      console.log(`[YT] broadcasting state=${state} time=${time}`);
      if (state === 1) sendSyncRef.current({ type: "play", time });
      if (state === 2) sendSyncRef.current({ type: "pause", time });
    },
    [],
  );

  const { loadVideo, playVideo, pauseVideo, seekTo } = useYouTubePlayer(
    playerContainerRef,
    { onStateChange: handleStateChange },
  );

  const handleRemoteSync = useCallback(
    (msg: SyncMessage) => {
      console.log(`[YT] remote sync received:`, msg);
      if (msg.type === "load") {
        setHasVideo(true);
        setMinimised(false);
        loadVideo(msg.videoId);
      } else if (msg.type === "play") {
        console.log(`[YT] applying remote play, setting isSyncing=true`);
        isSyncingRef.current = true;
        seekTo(msg.time);
        playVideo();
      } else if (msg.type === "pause") {
        console.log(`[YT] applying remote pause, setting isSyncing=true`);
        isSyncingRef.current = true;
        seekTo(msg.time);
        pauseVideo();
      } else if (msg.type === "seek") {
        isSyncingRef.current = true;
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
    <Draggable
      nodeRef={nodeRef as React.RefObject<HTMLElement>}
      handle=".drag-handle"
      bounds="parent"
    >
      <div
        ref={nodeRef}
        className="absolute bottom-6 right-6 z-50 w-80 bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header / drag handle */}
        <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none">
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
        </div>

        {!minimised && (
          <>
            {/* URL input */}
            <div className="px-3 py-2 flex gap-2">
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
              <div className="px-3 pb-3 text-center text-zinc-600 text-xs">
                Paste a YouTube URL above to watch together
              </div>
            )}
          </>
        )}

        {/*
          The player container lives OUTSIDE the minimised conditional so the
          YT.Player instance is never destroyed when the widget is collapsed.
          It's hidden via CSS when there's no video or when minimised — the
          iframe still exists in the DOM and can receive imperative commands.
        */}
        <div
          ref={playerContainerRef}
          className={`w-full aspect-video ${!hasVideo || minimised ? "hidden" : ""}`}
        />
      </div>
    </Draggable>
  );
}
