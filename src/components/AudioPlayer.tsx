import { useState, useRef, useCallback, useEffect } from "react";
import { DockButton } from "./Dock";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import type { DataConnection } from "peerjs";

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  id,
  dataConnection,
  initialFile,
  onClose,
  spatialVolume = 1,
  docked = false,
  onToggleDock,
  onTrackChange,
  transferProgress,
  onFileChosen,
}: {
  id: string;
  dataConnection: DataConnection | null;
  initialFile?: File;
  onClose?: () => void;
  /** 0–1 multiplier from spatial positioning — updated by the parent on every canvas transform change. */
  spatialVolume?: number;
  /** Whether this panel currently has a dock shortcut. */
  docked?: boolean;
  onToggleDock?: () => void;
  /** Reports the loaded track name so the parent can label the dock chip. */
  onTrackChange?: (name: string) => void;
  /** 0–1 while a file is still arriving over the data channel. */
  transferProgress?: number;
  /**
   * A file the *local* user picked or dropped onto this panel, so the parent
   * can stream it to the peer. Deliberately not called for a file that arrived
   * from the peer, which would bounce it straight back.
   */
  onFileChosen?: (file: File) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const syncUntilRef = useRef(0);
  const sendSyncRef = useRef<(message: SyncMessage) => void>(() => {});

  const [fileName, setFileName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [minimised, setMinimised] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleRemoteSync = useCallback(
    (message: SyncMessage) => {
      if (
        message.type !== "audio-play" &&
        message.type !== "audio-pause" &&
        message.type !== "audio-seek"
      )
        return;
      if (message.id !== id) return;

      const audio = audioRef.current;
      if (!audio || !audio.src) return;
      syncUntilRef.current = Date.now() + 500;
      audio.currentTime = Math.max(
        0,
        Math.min(message.time, Number.isFinite(audio.duration) ? audio.duration : message.time),
      );
      setCurrentTime(audio.currentTime);

      if (message.type === "audio-play") {
        audio.play().catch(() => {
          // Browser autoplay policy may require a local interaction first.
        });
      } else if (message.type === "audio-pause") {
        audio.pause();
      }
    },
    [id],
  );

  const { sendSync } = useYouTubeSync({
    dataConnection,
    onRemoteSync: handleRemoteSync,
  });
  sendSyncRef.current = sendSync;

  const loadedFileRef = useRef<File | null>(null);

  const loadFile = useCallback((file: File) => {
    if (!audioRef.current) return;
    // Revoke previous object URL to free memory
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    audioRef.current.src = url;
    audioRef.current.load();
    const name = file.name.replace(/\.[^.]+$/, "");
    setFileName(name);
    onTrackChange?.(name);
    setCurrentTime(0);
    setIsPlaying(false);
    setMinimised(false);
  }, [onTrackChange]);

  // Load the file whenever one turns up. It may be present at mount (a local
  // drop) or arrive later, once a chunked transfer from the peer completes.
  useEffect(() => {
    if (initialFile && loadedFileRef.current !== initialFile) {
      loadedFileRef.current = initialFile;
      loadFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // ── File input ────────────────────────────────────────────────────────
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadedFileRef.current = file;
    loadFile(file);
    onFileChosen?.(file);
  };

  // ── Drag and drop ─────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.match(/audio\/(mpeg|wav|ogg|flac|aac|mp4)/)) return;
    loadedFileRef.current = file;
    loadFile(file);
    onFileChosen?.(file);
  };

  // ── Playback controls ─────────────────────────────────────────────────
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !fileName) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = parseFloat(e.target.value);
    audio.currentTime = t;
    setCurrentTime(t);
    sendSync({ type: "audio-seek", id, time: t });
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current)
      audioRef.current.volume = Math.min(1, v * spatialVolume);
  };

  // Keep audio.volume in sync whenever spatialVolume changes from the parent
  useEffect(() => {
    if (audioRef.current)
      audioRef.current.volume = Math.min(1, volume * spatialVolume);
  }, [spatialVolume, volume]);

  // ── Audio element events ──────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => {
      setIsPlaying(true);
      if (Date.now() >= syncUntilRef.current) {
        sendSyncRef.current({
          type: "audio-play",
          id,
          time: audio.currentTime,
        });
      }
    };
    const onPause = () => {
      setIsPlaying(false);
      if (Date.now() >= syncUntilRef.current) {
        sendSyncRef.current({
          type: "audio-pause",
          id,
          time: audio.currentTime,
        });
      }
    };
    const onEnded = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
    };
  }, [id]);

  // Revoke object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden">
      {/* Hidden audio element */}
      <audio ref={audioRef} preload="metadata" />

      {/* Header / drag handle */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-violet-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <span className="text-xs font-semibold text-zinc-300">
            Record Player
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
        <div className="flex flex-col flex-1 gap-2 px-3 py-2 min-w-0">
          {transferProgress !== undefined && !fileName ? (
            /* ── Arriving over the data channel ── */
            <div className="flex flex-col items-center justify-center flex-1 gap-2 px-3">
              <p className="text-xs text-zinc-400">Receiving track…</p>
              <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-[width] duration-150"
                  style={{ width: `${Math.round(transferProgress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500 tabular-nums">
                {Math.round(transferProgress * 100)}%
              </p>
            </div>
          ) : !fileName ? (
            /* ── Drop zone ── */
            <label
              className={`flex flex-col items-center justify-center flex-1 rounded-xl border-2 border-dashed transition-colors cursor-pointer select-none ${
                isDragOver
                  ? "border-violet-500 bg-violet-500/10"
                  : "border-zinc-700 hover:border-zinc-500"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept="audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/aac,audio/mp4,.mp3,.wav,.ogg,.flac,.aac,.m4a"
                className="sr-only"
                onChange={handleFileInput}
              />
              <svg
                className="w-8 h-8 text-zinc-500 mb-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"
                />
              </svg>
              <p className="text-xs text-zinc-500 text-center px-2">
                Drop an mp3 or wav here
              </p>
              <p className="text-xs text-zinc-600 mt-0.5">or click to browse</p>
            </label>
          ) : (
            /* ── Player controls ── */
            <>
              {/* Top-down turntable deck */}
              <div className="relative flex-1 min-h-[180px] overflow-hidden rounded-xl border border-amber-950/70 bg-[linear-gradient(135deg,#8a5839,#c18a5d_48%,#74462f)] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-10px_25px_rgba(35,16,8,0.28)]">
                {/* Platter */}
                <div className="absolute left-3 top-1/2 h-[calc(100%-1.5rem)] max-h-[240px] aspect-square -translate-y-1/2 rounded-full bg-zinc-700 p-[5px] shadow-[0_8px_18px_rgba(0,0,0,0.45),inset_0_0_0_2px_rgba(255,255,255,0.08)]">
                  <div
                    className="record-vinyl relative h-full w-full rounded-full overflow-hidden shadow-[inset_0_0_16px_rgba(255,255,255,0.08)]"
                    style={{ animationPlayState: isPlaying ? "running" : "paused" }}
                  >
                    <div className="absolute inset-[9%] rounded-full border border-zinc-700/80" />
                    <div className="absolute inset-[18%] rounded-full border border-zinc-700/70" />
                    <div className="absolute inset-[27%] rounded-full border border-zinc-700/60" />
                    <div className="absolute inset-[34%] rounded-full bg-violet-600 border-2 border-violet-300/30 shadow-inner">
                      <div className="absolute inset-[44%] rounded-full bg-zinc-100 shadow" />
                      <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-[7px] leading-none text-center text-violet-100 font-semibold truncate">
                        {fileName}
                      </span>
                    </div>
                    <div className="absolute inset-0 rounded-full bg-[linear-gradient(115deg,transparent_42%,rgba(255,255,255,0.11)_49%,transparent_56%)]" />
                  </div>
                </div>

                {/* Tonearm assembly */}
                <div className="absolute right-4 top-4 h-9 w-9 rounded-full bg-zinc-300 border-[5px] border-zinc-600 shadow-[0_3px_8px_rgba(0,0,0,0.45)]">
                  <div
                    className="absolute left-1/2 top-1/2 h-[125px] w-2 origin-top -translate-x-1/2 rounded-full bg-gradient-to-r from-zinc-500 via-zinc-100 to-zinc-500 shadow-md transition-transform duration-700 ease-out"
                    style={{ transform: `translateX(-50%) rotate(${38 - progress * 0.18}deg)` }}
                  >
                    <div className="absolute -bottom-3 left-1/2 h-5 w-3 -translate-x-1/2 rounded-sm bg-zinc-800 shadow" />
                  </div>
                </div>

                {/* Deck controls */}
                <button
                  onClick={togglePlay}
                  className={`absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition-colors ${
                    isPlaying
                      ? "bg-violet-600 border-violet-300 text-white"
                      : "bg-zinc-800 border-zinc-500 text-zinc-200 hover:bg-zinc-700"
                  }`}
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4 translate-x-px" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <div className={`absolute right-5 bottom-16 h-2 w-2 rounded-full transition-colors ${isPlaying ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-red-950"}`} />
              </div>

              {/* Track name + swap file button */}
              <div className="flex items-center gap-1 min-w-0">
                <p
                  className="text-xs text-zinc-200 font-medium truncate flex-1"
                  title={fileName}
                >
                  {fileName}
                </p>
                <label
                  className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  title="Load a different file"
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept="audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/aac,audio/mp4,.mp3,.wav,.ogg,.flac,.aac,.m4a"
                    className="sr-only"
                    onChange={handleFileInput}
                  />
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
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                </label>
              </div>

              {/* Seek bar */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 tabular-nums shrink-0 w-8 text-right">
                  {formatTime(currentTime)}
                </span>
                <div className="relative flex-1 h-1.5 group">
                  <div className="absolute inset-0 bg-zinc-700 rounded-full" />
                  <div
                    className="absolute inset-y-0 left-0 bg-violet-500 rounded-full pointer-events-none"
                    style={{ width: `${progress}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
                  />
                </div>
                <span className="text-xs text-zinc-500 tabular-nums shrink-0 w-8">
                  {formatTime(duration)}
                </span>
              </div>

              {/* Volume */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <svg
                    className="w-3.5 h-3.5 text-zinc-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d={
                        volume === 0
                          ? "M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.96 6.96 0 0112.18 19c-.65 0-1.27-.12-1.86-.32l-1.51 1.51A8.928 8.928 0 0012 21a8.95 8.95 0 005.42-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                          : volume < 0.5
                            ? "M18.5 12A4.5 4.5 0 0016 7.97v8.05A4.48 4.48 0 0018.5 12zM5 9v6h4l5 5V4L9 9H5z"
                            : "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77z"
                      }
                    />
                  </svg>
                  <div className="relative flex-1 h-1.5">
                    <div className="absolute inset-0 bg-zinc-700 rounded-full" />
                    <div
                      className="absolute inset-y-0 left-0 bg-zinc-500 rounded-full pointer-events-none"
                      style={{ width: `${volume * 100}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={volume}
                      onChange={handleVolume}
                      className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
