import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";

/**
 * Whiteboard — a full-screen collaborative drawing canvas.
 *
 * ## Canvas sizing
 * The canvas buffer is sized to `innerWidth × devicePixelRatio` by
 * `innerHeight × devicePixelRatio` (physical pixels) with CSS dimensions set
 * to `innerWidth × innerHeight` (logical pixels). This keeps strokes crisp on
 * Retina/HiDPI screens. On window resize the canvas is re-sized and the
 * background is re-filled (existing art is lost — acceptable trade-off).
 *
 * ## Coordinate normalisation
 * Mouse positions are normalised to 0–1 fractions of the viewport before being
 * emitted via `onStroke`. The `drawSegment` function multiplies by the local
 * physical pixel dimensions when rendering, so strokes sent over the wire land
 * at the correct proportional position on the remote peer's screen regardless
 * of their viewport size or DPR.
 *
 * ## Brush width normalisation
 * The raw toolbar pixel size is divided by `Math.min(innerWidth, innerHeight)`
 * before sending. On receipt it is multiplied back out using the receiver's
 * own viewport, keeping stroke weight visually proportional across screen sizes.
 *
 * ## Imperative handle
 * `drawStroke` and `clearCanvas` are exposed via `forwardRef` / `useImperativeHandle`
 * so Session.tsx can apply remote strokes and clears without the component
 * needing to subscribe to any state.
 */

export interface WhiteboardStroke {
  x0: number; // normalised 0–1 fraction of viewport width
  y0: number; // normalised 0–1 fraction of viewport height
  x1: number;
  y1: number;
  color: string;
  width: number; // normalised: fraction of Math.min(viewportW, viewportH)
}

export interface WhiteboardHandle {
  drawStroke(stroke: WhiteboardStroke): void;
  clearCanvas(): void;
}

interface WhiteboardProps {
  tool: "pen" | "eraser";
  color: string;
  width: number; // raw toolbar pixel size (3 / 8 / 16)
  onStroke: (stroke: WhiteboardStroke) => void;
  canvasTransform: { x: number; y: number; scale: number };
}

const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(
  ({ tool, color, width, onStroke, canvasTransform }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    // All strokes in world-normalised space, so they can be replayed on zoom/pan
    const strokesRef = useRef<WhiteboardStroke[]>([]);
    // Always-current transform without stale closure issues
    const canvasTransformRef = useRef(canvasTransform);
    canvasTransformRef.current = canvasTransform;

    // Draw a segment from world-normalised coordinates.
    // Applies the current canvas transform (pan + zoom) so strokes live in
    // world-space and scale / pan correctly when the view changes.
    const drawSegment = useCallback((stroke: WhiteboardStroke) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const { x: tx, y: ty, scale } = canvasTransformRef.current;

      // World-normalised → world pixels → screen pixels → physical pixels
      const px0 = (stroke.x0 * vw * scale + tx) * dpr;
      const py0 = (stroke.y0 * vh * scale + ty) * dpr;
      const px1 = (stroke.x1 * vw * scale + tx) * dpr;
      const py1 = (stroke.y1 * vh * scale + ty) * dpr;

      const isEraser = stroke.color === "__eraser__";
      ctx.globalCompositeOperation = isEraser
        ? "destination-out"
        : "source-over";
      ctx.beginPath();
      ctx.moveTo(px0, py0);
      ctx.lineTo(px1, py1);
      ctx.strokeStyle = isEraser ? "rgba(0,0,0,1)" : stroke.color;
      // Width is normalised to viewport — also scale it with the zoom level
      ctx.lineWidth = stroke.width * Math.min(vw, vh) * scale * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }, []); // stable — reads transform from ref

    // Clear and repaint all stored strokes (called on zoom/pan/resize)
    const redrawAll = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const stroke of strokesRef.current) drawSegment(stroke);
    }, [drawSegment]);

    // Size the canvas to physical pixels so it stays sharp on high-DPR screens.
    const applySize = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Redraw strokes after resize (canvas buffer was wiped)
      redrawAll();
    }, [redrawAll]);

    useEffect(() => {
      applySize();
      window.addEventListener("resize", applySize);
      return () => window.removeEventListener("resize", applySize);
    }, [applySize]);

    // Redraw all strokes whenever the canvas transform (zoom/pan) changes
    useEffect(() => {
      redrawAll();
    }, [canvasTransform, redrawAll]);

    useImperativeHandle(
      ref,
      () => ({
        drawStroke(stroke: WhiteboardStroke) {
          strokesRef.current.push(stroke);
          drawSegment(stroke);
        },
        clearCanvas() {
          strokesRef.current = [];
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
      }),
      [drawSegment],
    );

    // Convert screen position to world-normalised coords (factors out zoom+pan)
    const getPosFromClient = (clientX: number, clientY: number) => {
      const { x: tx, y: ty, scale } = canvasTransformRef.current;
      return {
        x: (clientX - tx) / scale / window.innerWidth,
        y: (clientY - ty) / scale / window.innerHeight,
      };
    };

    // ── Mouse handlers ───────────────────────────────────────────────────

    const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return; // left-click only; middle-click reserved for panning
      isDrawingRef.current = true;
      lastPointRef.current = getPosFromClient(e.clientX, e.clientY);
    };

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const curr = getPosFromClient(e.clientX, e.clientY);
      emitStroke(curr);
    };

    const stopDrawing = () => {
      isDrawingRef.current = false;
      lastPointRef.current = null;
    };

    // ── Touch handlers (iOS / Android) ───────────────────────────────────

    const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
      // Multi-touch is reserved for canvas pinch-to-zoom — cancel any drawing
      if (e.touches.length !== 1) {
        isDrawingRef.current = false;
        lastPointRef.current = null;
        return;
      }
      const touch = e.touches[0];
      isDrawingRef.current = true;
      lastPointRef.current = getPosFromClient(touch.clientX, touch.clientY);
    };

    const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
      // A second finger was placed mid-stroke — stop drawing
      if (e.touches.length !== 1) {
        isDrawingRef.current = false;
        lastPointRef.current = null;
        return;
      }
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const touch = e.touches[0];
      const curr = getPosFromClient(touch.clientX, touch.clientY);
      emitStroke(curr);
    };

    // ── Shared stroke emitter ────────────────────────────────────────────

    const emitStroke = (curr: { x: number; y: number }) => {
      if (!lastPointRef.current) return;
      const prev = lastPointRef.current;
      const rawPx = tool === "eraser" ? width * 5 : width;
      const stroke: WhiteboardStroke = {
        x0: prev.x,
        y0: prev.y,
        x1: curr.x,
        y1: curr.y,
        color: tool === "eraser" ? "__eraser__" : color,
        // Normalise so it looks proportionally the same on the remote screen
        width: rawPx / Math.min(window.innerWidth, window.innerHeight),
      };
      strokesRef.current.push(stroke);
      drawSegment(stroke);
      onStroke(stroke);
      lastPointRef.current = curr;
    };

    return (
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          zIndex: 0,
          cursor: tool === "eraser" ? "cell" : "crosshair",
          touchAction: "none",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={stopDrawing}
        onTouchCancel={stopDrawing}
      />
    );
  },
);

Whiteboard.displayName = "Whiteboard";
export { Whiteboard };
