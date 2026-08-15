import type { CanvasItem } from "../components/Whiteboard";
import type { CodeContent, NoteContent, PanelState } from "../types/panels";

export const ROOM_STATE_VERSION = 2;

export interface PersistedPlayback {
  recordingId?: string;
  time: number;
  playing: boolean;
  volume?: number;
}

export interface PersistedRecording {
  id: string;
  name: string;
}

export interface PersistedPanel {
  id: string;
  type: "youtube" | "audio" | "browser" | "note" | "code" | "recorder" | "image";
  state: PanelState;
  initialVideoId?: string;
  initialUrl?: string;
  note?: NoteContent;
  code?: CodeContent;
  audioFileName?: string;
  imageFileName?: string;
  recordings?: PersistedRecording[];
  playback?: PersistedPlayback;
}

export interface PersistedPositionTag {
  id: string;
  x: number;
  y: number;
  label: string;
  w?: number;
  h?: number;
}

export interface PersistedConnector {
  id: string;
  fromPanelId: string;
  toPanelId: string;
  color: string;
  width: number;
}

export interface RoomSnapshot {
  version: number;
  savedAt: number;
  viewport: { width: number; height: number };
  panels: PersistedPanel[];
  fixedPanels: Record<"local" | "remote", PanelState>;
  /** Per-peer participant panels, keyed by the stable PeerJS id seen locally. */
  remotePanels?: Record<string, PanelState>;
  drawings: CanvasItem[];
  positionTags: PersistedPositionTag[];
  connectors?: PersistedConnector[];
  dockedIds: string[];
  panelLabels: Record<string, string>;
  customLabels: Record<string, string>;
  canvas: { x: number; y: number; scale: number };
}

const roomKey = (roomCode: string) => `watchtogether:room:${roomCode}`;
const mediaKey = (roomCode: string, panelId: string, recordingId?: string) =>
  `${roomCode}:${panelId}:${recordingId ?? "audio"}`;

export function loadRoomSnapshot(roomCode: string): RoomSnapshot | null {
  try {
    const raw = localStorage.getItem(roomKey(roomCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoomSnapshot;
    return parsed.version === ROOM_STATE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function saveRoomSnapshot(roomCode: string, snapshot: RoomSnapshot): void {
  try {
    localStorage.setItem(roomKey(roomCode), JSON.stringify(snapshot));
  } catch {
    // Private browsing and exhausted quotas can reject localStorage writes.
  }
}

const DB_NAME = "watchtogether-media";
const STORE_NAME = "room-media";

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRoomMedia(roomCode: string, panelId: string, file: File, recordingId?: string): Promise<void> {
  const db = await openMediaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(file, mediaKey(roomCode, panelId, recordingId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadRoomMedia(roomCode: string, panelId: string, recordingId?: string): Promise<File | null> {
  const db = await openMediaDb();
  const result = await new Promise<File | null>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(mediaKey(roomCode, panelId, recordingId));
    request.onsuccess = () => resolve(request.result instanceof File ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}
