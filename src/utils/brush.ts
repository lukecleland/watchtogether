/**
 * Brush vocabulary shared by the whiteboard and its toolbar.
 *
 * Kept out of the component files so both can import it without breaking fast
 * refresh, which requires a component module to export only components.
 */

/** How a stroke is drawn. Ballpoint is the original flat line. */
export type Nib =
  | "ballpoint"
  | "fountain"
  | "pencil"
  | "charcoal"
  | "highlighter"
  | "neon";

/**
 * Metallic "colours" are materials rather than flat fills: each segment is
 * painted with a gradient running *across* it — dark edge, bright core, dark
 * edge — which is what reads as metal rather than as flat yellow. Sent over
 * the wire as `metal:gold`, the same trick as the `__eraser__` sentinel.
 */
export const METALS: Record<string, [string, string, string]> = {
  gold: ["#6b4a09", "#ffe9a3", "#8a5f10"],
  silver: ["#5a5f66", "#f4f6f8", "#6b7178"],
  copper: ["#5e2f18", "#ffc9a0", "#7a3d1f"],
  bronze: ["#4a3510", "#e0b978", "#5e441a"]
};

/** The metal ramp for a colour string, or null if it isn't a metallic. */
export function metalFor(color: string): [string, string, string] | null {
  return color.startsWith("metal:") ? (METALS[color.slice(6)] ?? null) : null;
}
