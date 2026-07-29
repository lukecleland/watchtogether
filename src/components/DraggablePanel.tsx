import { useRef } from "react";
import Draggable, {
  type DraggableEvent,
  type DraggableData,
} from "react-draggable";
import type { PanelState } from "../types/panels";

/**
 * DraggablePanel — a controlled drag + resize container for a single panel.
 *
 * ## Drag
 * Uses react-draggable in controlled mode (`position` prop) so remote state
 * updates (from `onSyncUpdate`) are reflected immediately without fighting
 * react-draggable's internal position tracking.
 *
 * ## Resize
 * A custom bottom-right corner handle listens to raw `mousemove`/`mouseup`
 * events on `window` so the drag doesn't break when the cursor moves outside
 * the panel boundary quickly.
 *
 * ## Sync throttle
 * Both drag and resize schedule `onSyncUpdate` via a 50 ms debounce (~20 fps)
 * to avoid flooding the data channel. The final position is always flushed
 * immediately on drag/resize stop.
 *
 * ## z-order
 * `onBringToFront` is called on `pointerdown`; Session.tsx increments a shared
 * `topZRef` counter and updates the panel's `z` value, which is applied as
 * `zIndex` on the wrapper div and synced to the remote peer.
 */

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
  /** Canvas zoom scale — passed to react-draggable so drag deltas are correct. */
  scale?: number;
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
  scale = 1,
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
  const startResize = (startX: number, startY: number) => {
    const origin = {
      mx: startX,
      my: startY,
      w: stateRef.current.width,
      h: stateRef.current.height,
    };

    const applyResize = (clientX: number, clientY: number): PanelState => ({
      ...stateRef.current,
      width: Math.max(minWidth, origin.w + (clientX - origin.mx) / scale),
      height: Math.max(minHeight, origin.h + (clientY - origin.my) / scale),
    });

    const onMouseMove = (ev: MouseEvent) => {
      onLocalUpdate(applyResize(ev.clientX, ev.clientY));
      scheduleSyncUpdate(applyResize(ev.clientX, ev.clientY));
    };

    const onMouseUp = (ev: MouseEvent) => {
      const next = applyResize(ev.clientX, ev.clientY);
      onLocalUpdate(next);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      onSyncUpdate(next);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      const next = applyResize(t.clientX, t.clientY);
      onLocalUpdate(next);
      scheduleSyncUpdate(next);
    };

    const onTouchEnd = (ev: TouchEvent) => {
      const t = ev.changedTouches[0];
      const next = applyResize(t.clientX, t.clientY);
      onLocalUpdate(next);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      onSyncUpdate(next);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
  };

  const startResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startResize(e.clientX, e.clientY);
  };

  const startResizeTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    startResize(touch.clientX, touch.clientY);
  };

  return (
    <Draggable
      nodeRef={nodeRef as React.RefObject<HTMLElement>}
      position={{ x: state.x, y: state.y }}
      onDrag={handleDrag}
      onStop={handleDragStop}
      handle=".drag-handle"
      cancel=".no-drag"
      scale={scale}
      enableUserSelectHack={false}
    >
      <div
        ref={nodeRef}
        style={{
          width: state.width,
          height: state.height,
          zIndex: state.z,
          // The full-screen transformed parent is click-through so it cannot
          // block whiteboard strokes; only visible panels opt back in.
          pointerEvents: "auto",
        }}
        className={`absolute ${className}`}
        onPointerDown={onBringToFront}
      >
        {children}

        {/* Resize handle — bottom-right corner, larger hit area for touch */}
        <div
          onMouseDown={startResizeMouseDown}
          onTouchStart={startResizeTouchStart}
          className="no-drag absolute bottom-0 right-0 w-8 h-8 z-20 cursor-se-resize rounded-br-xl"
          style={{
            background:
              "linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.18) 40%)",
          }}
        />
      </div>
    </Draggable>
  );
}
