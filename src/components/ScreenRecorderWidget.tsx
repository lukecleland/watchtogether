import { useCallback, useEffect, useRef, useState } from "react";
import { DockButton } from "./Dock";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import type { RoomDataConnection } from "../hooks/usePeer";
import type { PanelPlayback, RecordingClip } from "../types/panels";

export interface RecordingStatus {
  recording: boolean;
  paused: boolean;
  errors: string[];
}

interface ScreenRecorderWidgetProps {
  id: string;
  dataConnection: RoomDataConnection | null;
  recordings?: RecordingClip[];
  onRecordingComplete: (recording: RecordingClip) => void;
  onStatusChange: (status: RecordingStatus) => void;
  transferProgress?: number;
  onClose?: () => void;
  docked?: boolean;
  onToggleDock?: () => void;
  initialPlayback?: PanelPlayback;
  onPlaybackChange?: (playback: PanelPlayback) => void;
  title?: string;
  /** Resolves the live canvas workspace without invoking display capture. */
  getCanvasElement: () => HTMLElement | null;
}

interface CaptureSession {
  stream: MediaStream;
  cleanup: () => void;
}

function recordingMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}

function syncedTime(time: number, sentAt?: number): number {
  return sentAt ? time + Math.max(0, Date.now() - sentAt) / 1000 : time;
}

async function createCanvasCapture(target: HTMLElement): Promise<CaptureSession> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const canvas = document.createElement("canvas");
  const bounds = target.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(bounds.width));
  canvas.height = Math.max(1, Math.round(bounds.height));
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") throw new Error("Canvas recording is not supported by this browser.");

  let stopped = false;
  let timer = 0;
  const render = async () => {
    if (stopped) return;
    try {
      const snapshot = await html2canvas(target, {
        backgroundColor: "#111111",
        logging: false,
        scale: 1,
        useCORS: true,
        width: canvas.width,
        height: canvas.height,
        ignoreElements: element => element.hasAttribute("data-canvas-chrome") || element.hasAttribute("data-recording-exclude"),
      });
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
    } finally {
      if (!stopped) timer = window.setTimeout(() => void render(), 100);
    }
  };
  await render();

  const stream = canvas.captureStream(30);
  return {
    stream,
    cleanup: () => {
      stopped = true;
      window.clearTimeout(timer);
      stream.getTracks().forEach(track => track.stop());
    },
  };
}

export function ScreenRecorderWidget({
  id,
  dataConnection,
  recordings = [],
  onRecordingComplete,
  onStatusChange,
  transferProgress,
  onClose,
  docked = false,
  onToggleDock,
  initialPlayback,
  onPlaybackChange,
  title = "Canvas recorder",
  getCanvasElement,
}: ScreenRecorderWidgetProps) {
  const [clips, setClips] = useState<RecordingClip[]>(recordings);
  const [selectedId, setSelectedId] = useState<string | null>(initialPlayback?.recordingId ?? recordings[0]?.id ?? null);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureCleanupRef = useRef<(() => void) | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const syncUntilRef = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  const initialPlaybackRef = useRef(initialPlayback);
  const onPlaybackChangeRef = useRef(onPlaybackChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
    onPlaybackChangeRef.current = onPlaybackChange;
  }, [onPlaybackChange, onStatusChange]);

  const urlFor = useCallback((clip: RecordingClip) => {
    const existing = urlsRef.current.get(clip.id);
    if (existing) return existing;
    const url = URL.createObjectURL(clip.file);
    urlsRef.current.set(clip.id, url);
    return url;
  }, []);

  const showClip = useCallback((clip: RecordingClip) => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = null;
    video.muted = false;
    const url = urlFor(clip);
    if (video.src !== url) {
      video.src = url;
      video.load();
      video.addEventListener("loadedmetadata", () => {
        const saved = initialPlaybackRef.current;
        if (!saved || saved.recordingId !== clip.id) return;
        video.currentTime = Math.min(saved.time, video.duration || saved.time);
        if (saved.playing) void video.play().catch(() => {});
        initialPlaybackRef.current = undefined;
      }, { once: true });
    }
    setSelectedId(clip.id);
  }, [urlFor]);

  useEffect(() => {
    setClips(previous => {
      const incoming = recordings.filter(clip => !previous.some(item => item.id === clip.id));
      if (incoming.length) setSelectedId(selected => selected ?? incoming[0].id);
      return incoming.length ? [...previous, ...incoming] : previous;
    });
  }, [recordings]);

  useEffect(() => {
    if (recording || !selectedId) return;
    const selected = clips.find(clip => clip.id === selectedId);
    if (selected) showClip(selected);
  }, [clips, recording, selectedId, showClip]);

  useEffect(() => {
    onStatusChangeRef.current({ recording, paused, errors });
  }, [errors, paused, recording]);

  useEffect(() => {
    if (recording || !selectedId || !onPlaybackChange) return;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (video) onPlaybackChangeRef.current?.({ recordingId: selectedId, time: video.currentTime, playing: !video.paused });
    }, 1000);
    return () => clearInterval(timer);
  }, [onPlaybackChange, recording, selectedId]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    captureCleanupRef.current?.();
    captureCleanupRef.current = null;
    urlsRef.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

  const handleRemoteSync = useCallback((message: SyncMessage) => {
    if (
      message.type !== "recording-select" &&
      message.type !== "recording-play" &&
      message.type !== "recording-pause" &&
      message.type !== "recording-seek"
    ) return;
    if (message.id !== id) return;
    const clip = clips.find(item => item.id === message.recordingId);
    if (!clip) return;
    showClip(clip);
    if (message.type === "recording-select") return;

    const video = videoRef.current;
    if (!video) return;
    syncUntilRef.current = Date.now() + 600;
    const requested = message.type === "recording-play" || (message.type === "recording-seek" && message.playing)
      ? syncedTime(message.time, message.at)
      : message.time;
    video.currentTime = Math.max(0, Math.min(requested, Number.isFinite(video.duration) ? video.duration : requested));
    if (message.type === "recording-play") void video.play().catch(() => {});
    if (message.type === "recording-pause") video.pause();
  }, [clips, id, showClip]);

  const { sendSync } = useYouTubeSync({ dataConnection, onRemoteSync: handleRemoteSync });

  const addError = (message: string) => setErrors(previous => previous.includes(message) ? previous : [...previous, message]);

  const stopCapture = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const startCapture = async () => {
    setErrors([]);
    let capture: CaptureSession | null = null;
    try {
      const canvasElement = getCanvasElement();
      if (!canvasElement) throw new Error("The canvas is not ready to record.");
      capture = await createCanvasCapture(canvasElement);
      const { stream } = capture;
      streamRef.current = stream;
      captureCleanupRef.current = capture.cleanup;

      const mimeType = recordingMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 128_000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => addError("The browser reported a recording error.");
      recorder.onstop = () => {
        const actualType = recorder.mimeType || mimeType || "video/webm";
        const extension = actualType.includes("mp4") ? "mp4" : "webm";
        const number = clips.length + 1;
        const file = new File(chunksRef.current, `Canvas recording ${number}.${extension}`, { type: actualType });
        const clip = { id: crypto.randomUUID(), name: file.name, file };
        setClips(previous => [...previous, clip]);
        setSelectedId(clip.id);
        onRecordingComplete(clip);
        captureCleanupRef.current?.();
        captureCleanupRef.current = null;
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setPaused(false);
      };
      const video = videoRef.current;
      if (video) {
        video.removeAttribute("src");
        video.srcObject = stream;
        video.muted = true;
        void video.play().catch(() => {});
      }
      recorder.start(1000);
      setRecording(true);
      setPaused(false);
    } catch (error) {
      capture?.cleanup();
      captureCleanupRef.current = null;
      streamRef.current = null;
      recorderRef.current = null;
      addError(error instanceof Error ? error.message : "Could not start recording.");
      setRecording(false);
      setPaused(false);
    }
  };

  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setPaused(true);
    } else if (recorder.state === "paused") {
      recorder.resume();
      setPaused(false);
    }
  };

  const selected = clips.find(clip => clip.id === selectedId) ?? null;
  const selectClip = (clip: RecordingClip) => {
    showClip(clip);
    sendSync({ type: "recording-select", id, recordingId: clip.id });
  };

  return (
    <div data-recording-exclude className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-xl">
      <div className="drag-handle flex shrink-0 cursor-grab items-center justify-between bg-zinc-900 px-3 py-2 active:cursor-grabbing">
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          <span className={`h-3 w-3 rounded-full ${recording && !paused ? "animate-pulse bg-red-500" : "bg-zinc-600"}`} />
          {title}
        </div>
        <div className="flex items-center gap-1">
          {onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
          {onClose && <button onClick={onClose} className="no-drag text-zinc-500 hover:text-red-400" aria-label="Close recorder">×</button>}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          playsInline
          controls={!recording && !!selected}
          onPlay={event => {
            if (!selected || Date.now() < syncUntilRef.current) return;
            sendSync({ type: "recording-play", id, recordingId: selected.id, time: event.currentTarget.currentTime, at: Date.now() });
          }}
          onPause={event => {
            if (!selected || Date.now() < syncUntilRef.current) return;
            sendSync({ type: "recording-pause", id, recordingId: selected.id, time: event.currentTarget.currentTime, at: Date.now() });
          }}
          onSeeked={event => {
            if (!selected || Date.now() < syncUntilRef.current) return;
            sendSync({ type: "recording-seek", id, recordingId: selected.id, time: event.currentTarget.currentTime, at: Date.now(), playing: !event.currentTarget.paused });
          }}
          className="h-full w-full bg-black object-contain"
        />
        {!recording && !selected && <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-zinc-600">Record the visible canvas without a screen-share prompt</div>}
      </div>

      <div className="no-drag flex shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
        <button onClick={() => void startCapture()} disabled={recording} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40">Record canvas</button>
        <button onClick={togglePause} disabled={!recording} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40">{paused ? "Resume" : "Pause"}</button>
        <button onClick={stopCapture} disabled={!recording} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40">Stop</button>
        {transferProgress !== undefined && <span className="ml-auto text-[10px] text-zinc-500">Sharing {Math.round(transferProgress * 100)}%</span>}
      </div>

      {clips.length > 0 && (
        <div className="no-drag max-h-32 shrink-0 overflow-auto border-t border-zinc-800 bg-zinc-950 p-2">
          {clips.map(clip => (
            <div key={clip.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${selectedId === clip.id ? "bg-zinc-800" : "hover:bg-zinc-900"}`}>
              <button onClick={() => selectClip(clip)} className="min-w-0 flex-1 truncate text-left text-xs text-zinc-300">{clip.name}</button>
              <a href={urlFor(clip)} download={clip.name} className="text-[11px] font-medium text-violet-400 hover:text-violet-300">Download</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
