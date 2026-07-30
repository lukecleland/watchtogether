import { useEffect, useRef, useState } from "react";

/**
 * Dock — a bottom-centre bar of shortcuts back to panels out on the canvas.
 *
 * ## What it is for
 * Panels can end up anywhere on the infinite canvas. Docking one adds a chip
 * here; clicking that chip flies the viewport back to the panel. The panel
 * itself never moves — this is navigation, not relocation.
 *
 * ## Shared bookmarks
 * Tagging a panel adds a chip to *both* docks — these are landmarks in the
 * shared canvas, not private shortcuts. A chip that arrived from the other
 * person pulses until you click it, so you notice it without your viewport
 * being hijacked. Renames are shared too.
 *
 * Dismissing, though, is local: your × clears your own bar only. Otherwise one
 * person could delete a bookmark out of the other's UI, which is how you get
 * "where did my pill go?".
 *
 * ## Renaming
 * The pencil button on a chip renames it. Submitting an empty name clears the
 * custom label and reverts to the automatic one — the video title, file name,
 * or a numbered fallback.
 *
 * Renaming is deliberately *not* on double-click: the chip's single click is
 * "jump to this panel", so a double-click would fire a viewport flight before
 * the rename box opened. Debouncing the click to detect double-clicks would
 * put latency on the common action to serve the rare one. The pencil and ×
 * are always visible rather than revealed on hover, since touch devices have
 * no hover state.
 *
 * Renders nothing when the dock is empty.
 */

export interface DockEntry {
  id: string;
  type: "local" | "remote" | "youtube" | "audio" | "position";
  label: string;
  /** True when the label is a user-set name rather than a derived one. */
  renamed?: boolean;
  /** Tagged by the other person and not yet acknowledged — pulses for attention. */
  pulsing?: boolean;
}

interface DockProps {
  entries: DockEntry[];
  /** Fly the viewport to this panel. */
  onJump: (id: string) => void;
  /** Remove this panel from the dock. */
  onRemove: (id: string) => void;
  /** Set a custom label; an empty string reverts to the automatic label. */
  onRename: (id: string, label: string) => void;
}

function DockIcon({ type }: { type: DockEntry["type"] }) {
  if (type === "position") {
    return (
      <svg
        className="w-4 h-4 text-amber-400 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M6 2a1 1 0 011 1v1h10.2a1 1 0 01.8 1.6L15.45 9 18 12.4a1 1 0 01-.8 1.6H8v7a1 1 0 11-2 0V2z" />
      </svg>
    );
  }
  if (type === "youtube") {
    return (
      <svg
        className="w-4 h-4 text-red-500 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    );
  }
  if (type === "audio") {
    return (
      <svg
        className="w-4 h-4 text-violet-400 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
      </svg>
    );
  }
  // local / remote video
  return (
    <svg
      className="w-4 h-4 text-zinc-400 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10l4.553-2.069A1 1 0 0121 8.806v6.388a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
      />
    </svg>
  );
}

/**
 * DockButton — the toggle that lives in a panel's header bar.
 * Filled bookmark = currently docked.
 */
export function DockButton({
  docked,
  onToggle,
}: {
  docked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`no-drag transition-colors ${
        docked ? "text-violet-400 hover:text-violet-300" : "text-zinc-400 hover:text-white"
      }`}
      title={docked ? "Remove from dock" : "Add to dock"}
      aria-label={docked ? "Remove from dock" : "Add to dock"}
      aria-pressed={docked}
    >
      <svg
        className="w-4 h-4"
        viewBox="0 0 24 24"
        fill={docked ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z"
        />
      </svg>
    </button>
  );
}

export function Dock({ entries, onJump, onRemove, onRename }: DockProps) {
  // id of the chip currently being renamed, plus its in-progress text
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the existing name when an edit starts, so typing replaces it
  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startEditing = (entry: DockEntry) => {
    setEditingId(entry.id);
    setDraft(entry.label);
  };

  const commitEditing = () => {
    if (editingId) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  if (entries.length === 0) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-zinc-900/90 backdrop-blur border border-zinc-700 rounded-2xl px-2 py-2 shadow-xl max-w-[calc(100vw-2rem)] overflow-x-auto"
      style={{
        zIndex: 999,
        bottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
    >
      {entries.map((entry) =>
        editingId === entry.id ? (
          // ── Rename mode ──
          <div
            key={entry.id}
            className="flex items-center gap-1.5 bg-zinc-800 border border-violet-500 rounded-xl pl-2 pr-1 py-1.5 shrink-0"
          >
            <DockIcon type={entry.type} />
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEditing}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEditing();
                if (e.key === "Escape") setEditingId(null);
              }}
              // The dock sits over the canvas, which binds space to pan mode
              onKeyUp={(e) => e.stopPropagation()}
              placeholder="Name (empty = auto)"
              aria-label="Rename dock item"
              autoFocus
              spellCheck={false}
              className="bg-transparent text-xs font-medium text-white placeholder:text-zinc-500 outline-none w-[10rem]"
            />
          </div>
        ) : (
          <div
            key={entry.id}
            className={`group flex items-center gap-1 rounded-xl pl-2 pr-1 py-1.5 transition-colors shrink-0 border ${
              entry.pulsing
                ? "dock-pulse bg-violet-950/60 border-violet-500"
                : "bg-zinc-800 hover:bg-zinc-700 border-zinc-700"
            }`}
          >
            <button
              onClick={() => onJump(entry.id)}
              className="flex items-center gap-1.5 min-w-0"
              title={
                entry.pulsing
                  ? `Go to ${entry.label} — just tagged by the other person`
                  : `Go to ${entry.label}`
              }
            >
              <DockIcon type={entry.type} />
              {/* Titles and filenames can be long — truncate; the full text
                  is available via the button's title tooltip. */}
              <span className="text-xs font-medium text-zinc-300 truncate max-w-[10rem]">
                {entry.label}
              </span>
            </button>

            <button
              onClick={() => startEditing(entry)}
              className="text-zinc-500 hover:text-violet-400 transition-colors shrink-0"
              title="Rename"
              aria-label={`Rename ${entry.label}`}
            >
              <svg
                className="w-3.5 h-3.5"
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

            <button
              onClick={() => onRemove(entry.id)}
              className="text-zinc-400 hover:text-red-400 transition-colors shrink-0"
              title="Undock (remove from this bar)"
              aria-label={`Remove ${entry.label} from dock`}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        ),
      )}
    </div>
  );
}
