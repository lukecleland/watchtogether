/**
 * Dock — a bottom-centre bar of shortcuts back to panels out on the canvas.
 *
 * ## What it is for
 * Panels can end up anywhere on the infinite canvas. Docking one adds a chip
 * here; clicking that chip flies the viewport back to the panel. The panel
 * itself never moves — this is navigation, not relocation.
 *
 * ## Per-user, not synced
 * Docking is a personal view preference, so nothing is sent over the data
 * channel. Docking a panel on one side leaves the other peer's dock untouched.
 *
 * Renders nothing when the dock is empty.
 */

export interface DockEntry {
  id: string;
  type: "local" | "remote" | "youtube" | "audio";
  label: string;
}

interface DockProps {
  entries: DockEntry[];
  /** Fly the viewport to this panel. */
  onJump: (id: string) => void;
  /** Remove this panel from the dock. */
  onRemove: (id: string) => void;
}

function DockIcon({ type }: { type: DockEntry["type"] }) {
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

export function Dock({ entries, onJump, onRemove }: DockProps) {
  if (entries.length === 0) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-zinc-900/90 backdrop-blur border border-zinc-700 rounded-2xl px-2 py-2 shadow-xl max-w-[calc(100vw-2rem)] overflow-x-auto"
      style={{
        zIndex: 999,
        bottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="group flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl pl-2 pr-1 py-1.5 transition-colors shrink-0"
        >
          <button
            onClick={() => onJump(entry.id)}
            className="flex items-center gap-1.5 min-w-0"
            title={`Go to ${entry.label}`}
          >
            <DockIcon type={entry.type} />
            {/* Video titles and filenames can be long — truncate, full text
                is available via the button's title tooltip. */}
            <span className="text-xs font-medium text-zinc-300 truncate max-w-[10rem]">
              {entry.label}
            </span>
          </button>
          <button
            onClick={() => onRemove(entry.id)}
            className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
            title="Remove from dock"
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
      ))}
    </div>
  );
}
