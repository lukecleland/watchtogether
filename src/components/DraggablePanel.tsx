import { useRef } from "react";
import Draggable, {
  type DraggableEvent,
  type DraggableData,
} from "react-draggable";
import type { PanelState } from "../types/panels";

interface DraggablePanelProps {
  state: PanelState;
  /** Called immediately on every drag/resize tick — update local state here. */
  onLocalUpdate: (next: PanelState) => void;
  /** Throttled — broadcast to the remote peer here. */
  onSyncUpdate: (next: PanelState) => void;
  /** Called on pointer-down to raise this panel above others. */
  onBringToFront: () => void;
  minWidth?: number;
  minHeight?: number;
  children: React.ReactNode;
  className?: string;
}

export function DraggablePanel({
  state,
  onLocalUpdate,
  onSyncUpdate,
  onBringToFront,
  minWidth = 240,
  minHeight = 140,
  children,
  className = "",
}: DraggablePanelProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  // Always-current copy of state so resize closure doesn't go stale
  const stateRef = useRef(state);
  stateRef.current = state;

  // Throttle remote sync to ~20fps during drag/resize to avoid flooding the data channel
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSyncUpdate = (next: PanelState) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      onSyncUpdate(next);
      syncTimerRef.current = null;
    }, 50);
  };

  // ── Drag ──────────────────────────────────────────────────────────────
  const handleDrag = (_: DraggableEvent, data: DraggableData) => {
    const next = { ...stateRef.current, x: data.x, y: data.y };
    onLocalUpdate(next);
    scheduleSyncUpdate(next);
  };

  const handleDragStop = (_: DraggableEvent, data: DraggableData) => {
    const next = { ...stateRef.current, x: data.x, y: data.y };
    onLocalUpdate(next);
    // Always flush on stop so final position is always sent
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    onSyncUpdate(next);
  };

  // ── Resize (bottom-right corner handle) ───────────────────────────────
  const startResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const origin = {
      mx: e.clientX,
      my: e.clientY,
      w: stateRef.current.width,
      h: stateRef.current.height,
    };

    const onMouseMove = (ev: MouseEvent) => {
      const next = {
        ...stateRef.current,
        width: Math.max(minWidth, origin.w + ev.clientX - origin.mx),
        height: Math.max(minHeight, origin.h + ev.clientY - origin.my),
      };
      onLocalUpdate(next);
      scheduleSyncUpdate(next);
    };

    const onMouseUp = (ev: MouseEvent) => {
      const next = {
        ...stateRef.current,
        width: Math.max(minWidth, origin.w + ev.clientX - origin.mx),
        height: Math.max(minHeight, origin.h + ev.clientY - origin.my),
      };
      onLocalUpdate(next);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      onSyncUpdate(next);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <Draggable
      nodeRef={nodeRef as React.RefObject<HTMLElement>}
      position={{ x: state.x, y: state.y }}
      onDrag={handleDrag}
      onStop={handleDragStop}
      handle=".drag-handle"
      cancel=".no-drag"
      bounds="parent"
    >
      <div
        ref={nodeRef}
        style={{ width: state.width, height: state.height, zIndex: state.z }}
        className={`absolute ${className}`}
        onPointerDown={onBringToFront}
      >
        {children}

        {/* Resize handle — bottom-right corner */}
        <div
          onMouseDown={startResizeMouseDown}
          className="no-drag absolute bottom-0 right-0 w-5 h-5 z-20 cursor-se-resize rounded-br-xl"
          style={{
            background:
              "linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.18) 40%)",
          }}
        />
      </div>
    </Draggable>
  );
}
