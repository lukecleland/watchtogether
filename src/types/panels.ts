/** Fixed video panel IDs (always present). */
export type PanelId = "local" | "remote";

/** The type of a dynamically-spawned panel. */
export type DynamicPanelType = "youtube" | "audio";

/**
 * Layout state for a single panel.
 *
 * Internally x/y/width/height are CSS pixels (used by react-draggable and the
 * DOM). When sent over the data channel they are first converted to viewport
 * fractions (0–1) by `normalisePanel` so the remote peer can place them
 * proportionally on their own (possibly different-resolution) screen.
 */
export interface PanelState {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

/** A dynamically spawned media panel (YouTube player or audio player). */
export interface DynamicPanel {
  id: string;
  type: DynamicPanelType;
  state: PanelState;
  initialVideoId?: string;
  initialFile?: File;
}
