import { useRef } from "react";
import Draggable from "react-draggable";

interface WhiteboardToolbarProps {
  tool: "pen" | "eraser";
  color: string;
  width: number;
  onToolChange: (t: "pen" | "eraser") => void;
  onColorChange: (c: string) => void;
  onWidthChange: (w: number) => void;
  onClear: () => void;
}

const COLORS = [
  "#ffffff",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#60a5fa",
  "#c084fc",
  "#f472b6",
];

const SIZES = [
  { label: "S", value: 3 },
  { label: "M", value: 8 },
  { label: "L", value: 16 },
];

export function WhiteboardToolbar({
  tool,
  color,
  width,
  onToolChange,
  onColorChange,
  onWidthChange,
  onClear,
}: WhiteboardToolbarProps) {
  const nodeRef = useRef<HTMLDivElement>(null);

  return (
    <Draggable
      nodeRef={nodeRef as React.RefObject<HTMLElement>}
      defaultPosition={{ x: 16, y: 64 }}
      handle=".wb-drag"
    >
      <div
        ref={nodeRef}
        style={{ position: "fixed", zIndex: 999 }}
        className="flex flex-col items-center gap-1.5 bg-zinc-900/90 backdrop-blur border border-zinc-700 rounded-2xl px-2 py-2.5 shadow-xl select-none"
      >
        {/* Drag handle */}
        <div className="wb-drag cursor-grab active:cursor-grabbing text-zinc-500 hover:text-zinc-300 transition-colors py-0.5">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="9" cy="5" r="1.5" />
            <circle cx="15" cy="5" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="19" r="1.5" />
            <circle cx="15" cy="19" r="1.5" />
          </svg>
        </div>

        <div className="w-6 border-t border-zinc-700" />

        {/* Pen */}
        <button
          onClick={() => onToolChange("pen")}
          title="Pen"
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
            tool === "pen"
              ? "bg-violet-600 text-white"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
          }`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.232 5.232l3.536 3.536M9 11l6.586-6.586a2 2 0 112.828 2.828L11.828 13.828a4 4 0 01-1.414.95l-3.31 1.103 1.104-3.31A4 4 0 019 11z"
            />
          </svg>
        </button>

        {/* Eraser */}
        <button
          onClick={() => onToolChange("eraser")}
          title="Eraser"
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
            tool === "eraser"
              ? "bg-violet-600 text-white"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
          }`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20.707 5.826l-2.534-2.533a1 1 0 00-1.414 0l-10 10a1 1 0 000 1.414l2.534 2.534 1.414-1.415-1.829-1.828 8.586-8.585 1.83 1.83-1.415 1.414 1.415 1.414 2.828-2.828a1 1 0 000-1.414zM4 20h7"
            />
          </svg>
        </button>

        <div className="w-6 border-t border-zinc-700" />

        {/* Color swatches */}
        {COLORS.map((c) => (
          <button
            key={c}
            title={c}
            onClick={() => {
              onToolChange("pen");
              onColorChange(c);
            }}
            style={{ background: c }}
            className={`w-6 h-6 rounded-full transition-transform hover:scale-110 ${
              color === c && tool === "pen"
                ? "ring-2 ring-white ring-offset-1 ring-offset-zinc-900 scale-110"
                : ""
            }`}
          />
        ))}

        <div className="w-6 border-t border-zinc-700" />

        {/* Brush sizes */}
        {SIZES.map((s) => (
          <button
            key={s.value}
            title={`Size ${s.label}`}
            onClick={() => onWidthChange(s.value)}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
              width === s.value ? "bg-zinc-600" : "hover:bg-zinc-800"
            }`}
          >
            <div
              style={{
                width: Math.min(s.value + 6, 20),
                height: Math.min(s.value + 6, 20),
                borderRadius: "50%",
                background: tool === "pen" ? color : "#6b7280",
              }}
            />
          </button>
        ))}

        <div className="w-6 border-t border-zinc-700" />

        {/* Clear */}
        <button
          onClick={onClear}
          title="Clear canvas"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>
    </Draggable>
  );
}
