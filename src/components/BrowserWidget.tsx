import { useCallback, useState } from "react";
import type { RoomDataConnection } from "../hooks/usePeer";
import { DockButton } from "./Dock";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";

function normaliseUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`,
    );
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function BrowserWidget({
  id,
  dataConnection,
  initialUrl,
  onClose,
  docked = false,
  onToggleDock,
  onTitleChange,
  onUrlChange,
  title = "Mini Browser",
}: {
  id: string;
  dataConnection: RoomDataConnection | null;
  initialUrl?: string;
  onClose?: () => void;
  docked?: boolean;
  onToggleDock?: () => void;
  onTitleChange?: (title: string) => void;
  onUrlChange?: (url: string) => void;
  title?: string;
}) {
  const [inputValue, setInputValue] = useState(initialUrl ?? "");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [inputError, setInputError] = useState(false);
  const [minimised, setMinimised] = useState(false);

  const handleRemoteSync = useCallback(
    (message: SyncMessage) => {
      if (message.type !== "browser-load" || message.id !== id) return;
      setInputValue(message.url);
      setUrl(message.url);
      setMinimised(false);
      onTitleChange?.(new URL(message.url).hostname);
      onUrlChange?.(message.url);
    },
    [id, onTitleChange, onUrlChange],
  );
  const { sendSync } = useYouTubeSync({
    dataConnection,
    onRemoteSync: handleRemoteSync,
  });

  const loadUrl = (nextUrl: string) => {
    setInputValue(nextUrl);
    setUrl(nextUrl);
    setMinimised(false);
    onTitleChange?.(new URL(nextUrl).hostname);
    onUrlChange?.(nextUrl);
    sendSync({ type: "browser-load", id, url: nextUrl });
  };

  const navigate = () => {
    const nextUrl = normaliseUrl(inputValue);
    if (nextUrl) loadUrl(nextUrl);
    else {
      setInputError(true);
      setTimeout(() => setInputError(false), 1500);
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden">
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-4 h-4 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
          </svg>
          <span className="text-xs font-semibold text-zinc-300 truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
          <button onClick={() => setMinimised(value => !value)} className="text-zinc-400 hover:text-white" aria-label={minimised ? "Expand" : "Minimise"}>
            {minimised ? "□" : "−"}
          </button>
          {onClose && <button onClick={onClose} className="text-zinc-500 hover:text-red-400" aria-label="Close">×</button>}
        </div>
      </div>

      {!minimised && (
        <>
          <div className="flex gap-2 px-2 py-2 bg-zinc-900 shrink-0">
            <input
              type="url"
              value={inputValue}
              onChange={event => setInputValue(event.target.value)}
              onPaste={event => {
                const nextUrl = normaliseUrl(event.clipboardData.getData("text"));
                if (!nextUrl) return;
                event.preventDefault();
                loadUrl(nextUrl);
              }}
              onKeyDown={event => event.key === "Enter" && navigate()}
              placeholder="Paste a URL…"
              spellCheck={false}
              className={`min-w-0 flex-1 bg-zinc-800 text-zinc-100 text-xs rounded-lg px-3 py-1.5 outline-none border ${inputError ? "border-red-500" : "border-zinc-700 focus:border-sky-500"}`}
            />
            <button onClick={navigate} className="bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-3 rounded-lg">
              Go
            </button>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="flex items-center text-zinc-400 hover:text-white px-1" title="Open in a new tab" aria-label="Open in a new tab">
                ↗
              </a>
            )}
          </div>
          <div className="relative flex-1 min-h-0 bg-white">
            {url ? (
              <iframe key={url} src={url} title="Mini browser" className="absolute inset-0 w-full h-full border-0" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500 bg-zinc-100">
                Enter a URL to browse
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
