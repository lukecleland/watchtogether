import { useEffect, useMemo } from "react";
import { DockButton } from "./Dock";

interface ImageWidgetProps {
  file?: File;
  title: string;
  transferProgress?: number;
  onClose: () => void;
  docked: boolean;
  onToggleDock: () => void;
}

export function ImageWidget({ file, title, transferProgress, onClose, docked, onToggleDock }: ImageWidgetProps) {
  const imageUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-xl">
      <div className="drag-handle flex shrink-0 cursor-grab items-center justify-between bg-zinc-900 px-2 py-1.5 text-zinc-300 active:cursor-grabbing">
        <span className="max-w-[70%] truncate text-xs font-semibold">{title}</span>
        <div className="flex items-center gap-1">
          <DockButton docked={docked} onToggle={onToggleDock} />
          <button className="no-drag px-1 text-zinc-400 hover:text-white" onClick={onClose} aria-label="Close image">×</button>
        </div>
      </div>
      <div className="no-drag relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40">
        {imageUrl ? (
          <img src={imageUrl} alt={title} draggable={false} className="h-full w-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 px-5 text-center text-xs text-zinc-500">
            <span className="text-2xl">▧</span>
            <span>{transferProgress === undefined ? "Waiting for image…" : `Receiving image… ${Math.round(transferProgress * 100)}%`}</span>
          </div>
        )}
        {!imageUrl && transferProgress !== undefined && (
          <div className="absolute inset-x-4 bottom-4 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-violet-500 transition-[width]" style={{ width: `${transferProgress * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
