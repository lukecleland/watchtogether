import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";

export interface WhiteboardStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

export interface WhiteboardHandle {
  drawStroke(stroke: WhiteboardStroke): void;
  clearCanvas(): void;
}

interface WhiteboardProps {
  tool: "pen" | "eraser";
  color: string;
  width: number;
  onStroke: (stroke: WhiteboardStroke) => void;
}

const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(
  ({ tool, color, width, onStroke }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);

    const fillBlack = useCallback((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const setSize = () => {
        // Save existing drawing before resize
        const ctx = canvas.getContext("2d");
        const imageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        if (!ctx) return;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (imageData) ctx.putImageData(imageData, 0, 0);
      };

      setSize();
      window.addEventListener("resize", setSize);
      return () => window.removeEventListener("resize", setSize);
    }, [fillBlack]);

    const drawSegment = useCallback((stroke: WhiteboardStroke) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      ctx.beginPath();
      ctx.moveTo(stroke.x0 * canvas.width, stroke.y0 * canvas.height);
      ctx.lineTo(stroke.x1 * canvas.width, stroke.y1 * canvas.height);
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        drawStroke(stroke: WhiteboardStroke) {
          drawSegment(stroke);
        },
        clearCanvas() {
          const canvas = canvasRef.current;
          if (canvas) fillBlack(canvas);
        },
      }),
      [drawSegment, fillBlack],
    );

    const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => ({
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    });

    const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
      isDrawingRef.current = true;
      lastPointRef.current = getPos(e);
    };

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const curr = getPos(e);
      const prev = lastPointRef.current;
      const stroke: WhiteboardStroke = {
        x0: prev.x,
        y0: prev.y,
        x1: curr.x,
        y1: curr.y,
        color: tool === "eraser" ? "#000000" : color,
        width: tool === "eraser" ? width * 5 : width,
      };
      drawSegment(stroke);
      onStroke(stroke);
      lastPointRef.current = curr;
    };

    const stopDrawing = () => {
      isDrawingRef.current = false;
      lastPointRef.current = null;
    };

    return (
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          cursor: tool === "eraser" ? "cell" : "crosshair",
          touchAction: "none",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
      />
    );
  },
);

Whiteboard.displayName = "Whiteboard";
export { Whiteboard };
