import { useEffect, useRef, useState } from "react";

/**
 * WhiteboardToolbar — a floating tool island with a contextual properties panel.
 *
 * ## Structure
 * Two pieces instead of one strip:
 *
 * - **Island** — pinned below the top bar, horizontally centred. Holds only
 *   what's always relevant: the tools, the current colour, and clear.
 * - **Properties panel** — anchored left, under the island, and shown only
 *   while a tool with options is selected. Colour and brush size live here.
 *
 * ## Why not a flat strip
 * The previous version put every option on screen permanently — two tools,
 * eight colour swatches, three sizes and clear, all competing for the same
 * vertical rail. That doesn't survive more tools being added, and on a phone it
 * occupied a fixed column of a screen where the canvas *is* the content.
 * Splitting "which tool" from "that tool's options" means new tools cost one
 * island slot each, and their options cost nothing until selected.
 *
 * ## Placement
 * Fixed rather than draggable. The old bar could be moved but was reset on every
 * reload, and being able to lose your toolbar behind a panel is not a feature.
 * The panel sits *below* the island rather than beside it so the two can never
 * collide on a narrow screen.
 *
 * The props are unchanged from the previous flat toolbar — this is a
 * presentation change only, so Session.tsx is untouched.
 */

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
  "#f472b6"
];

const SIZES = [
  { label: "S", value: 3 },
  { label: "M", value: 8 },
  { label: "L", value: 16 }
];

/** Below the top bar, allowing for the iOS safe-area inset. */
const TOP_OFFSET = "calc(3rem + env(safe-area-inset-top) + 0.5rem)";
const PANEL_OFFSET = "calc(3rem + env(safe-area-inset-top) + 3.5rem)";

export function WhiteboardToolbar({
  tool,
  color,
  width,
  onToolChange,
  onColorChange,
  onWidthChange,
  onClear
}: WhiteboardToolbarProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);

  // Clicking away closes the panel, so it never sits over the canvas unused
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || islandRef.current?.contains(t)) return;
      setPanelOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [panelOpen]);

  const selectTool = (t: "pen" | "eraser") => {
    // Re-tapping the active tool toggles its options rather than doing nothing
    if (t === tool) setPanelOpen(o => !o);
    else {
      onToolChange(t);
      setPanelOpen(true);
    }
  };

  const toolButton = (
    t: "pen" | "eraser",
    label: string,
    path: string
  ) => (
    <button
      onClick={() => selectTool(t)}
      title={label}
      aria-label={label}
      aria-pressed={tool === t}
      className={`w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
        tool === t
          ? "bg-violet-600 text-white"
          : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
      }`}
    >
      <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d={path} />
      </svg>
    </button>
  );

  return (
    <>
      {/* ── Island ─────────────────────────────────────────────────────── */}
      <div
        ref={islandRef}
        style={{ position: "fixed", zIndex: 999, top: TOP_OFFSET }}
        className="left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-2xl p-1.5 shadow-xl select-none"
      >
        {toolButton(
          "pen",
          "Pen",
          "M15.232 5.232l3.536 3.536M9 11l6.586-6.586a2 2 0 112.828 2.828L11.828 13.828a4 4 0 01-1.414.95l-3.31 1.103 1.104-3.31A4 4 0 019 11z"
        )}
        {toolButton(
          "eraser",
          "Eraser",
          "M20.707 5.826l-2.534-2.533a1 1 0 00-1.414 0l-10 10a1 1 0 000 1.414l2.534 2.534 1.414-1.415-1.829-1.828 8.586-8.585 1.83 1.83-1.415 1.414 1.415 1.414 2.828-2.828a1 1 0 000-1.414zM4 20h7"
        )}

        <div className="w-px h-6 bg-zinc-700 mx-0.5" />

        {/* Current colour — doubles as the properties toggle */}
        <button
          onClick={() => setPanelOpen(o => !o)}
          title="Colour and size"
          aria-label="Colour and size"
          aria-expanded={panelOpen}
          className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-zinc-700 transition-colors"
        >
          <span
            className="w-5 h-5 rounded-lg border border-zinc-500"
            style={{ background: tool === "eraser" ? "transparent" : color }}
          >
            {tool === "eraser" && (
              <svg className="w-full h-full text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M5 19L19 5" />
              </svg>
            )}
          </span>
        </button>

        <div className="w-px h-6 bg-zinc-700 mx-0.5" />

        <button
          onClick={onClear}
          title="Clear canvas"
          aria-label="Clear canvas"
          className="w-9 h-9 flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-400 hover:bg-zinc-700 transition-colors"
        >
          <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>

      {/* ── Properties ─────────────────────────────────────────────────── */}
      {panelOpen && (
        <div
          ref={panelRef}
          style={{ position: "fixed", zIndex: 999, top: PANEL_OFFSET }}
          className="left-3 sm:left-4 w-[13.5rem] bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-2xl p-3 shadow-xl select-none"
        >
          {tool === "pen" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Colour</p>
              <div className="grid grid-cols-8 gap-1.5 mb-3.5">
                {COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => onColorChange(c)}
                    title={c}
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    style={{ background: c }}
                    className={`w-full aspect-square rounded-md transition-transform hover:scale-110 ${
                      color === c ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900" : ""
                    }`}
                  />
                ))}
              </div>
            </>
          )}

          <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">
            {tool === "eraser" ? "Eraser size" : "Size"}
          </p>
          <div className="flex items-center gap-1.5">
            {SIZES.map(s => (
              <button
                key={s.value}
                onClick={() => onWidthChange(s.value)}
                title={`Size ${s.label}`}
                aria-label={`Size ${s.label}`}
                aria-pressed={width === s.value}
                className={`flex-1 h-9 flex items-center justify-center rounded-xl transition-colors ${
                  width === s.value ? "bg-zinc-700" : "hover:bg-zinc-800"
                }`}
              >
                <span
                  style={{
                    width: Math.min(s.value + 6, 20),
                    height: Math.min(s.value + 6, 20),
                    borderRadius: "50%",
                    background: tool === "pen" ? color : "#6b7280"
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
