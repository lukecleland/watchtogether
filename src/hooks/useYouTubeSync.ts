import { useCallback, useRef } from "react";
import type { DataConnection } from "peerjs";
import type { PanelId, PanelState } from "../types/panels";

export type SyncMessage =
  | { type: "load"; videoId: string }
  | { type: "play"; time: number }
  | { type: "pause"; time: number }
  | { type: "seek"; time: number }
  | { type: "panel-update"; id: PanelId; state: PanelState };

interface UseYouTubeSyncOptions {
  dataConnection: DataConnection | null;
  onRemoteSync: (msg: SyncMessage) => void;
}

interface UseYouTubeSyncResult {
  sendSync: (msg: SyncMessage) => void;
}

export function useYouTubeSync({
  dataConnection,
  onRemoteSync,
}: UseYouTubeSyncOptions): UseYouTubeSyncResult {
  const onRemoteSyncRef = useRef(onRemoteSync);
  onRemoteSyncRef.current = onRemoteSync;

  // Register the data handler when the component mounts/connection changes
  // We use useRef to track if we've already bound the handler
  const boundRef = useRef<DataConnection | null>(null);

  if (dataConnection && boundRef.current !== dataConnection) {
    boundRef.current = dataConnection;
    dataConnection.on("data", (raw) => {
      onRemoteSyncRef.current(raw as SyncMessage);
    });
  }

  const sendSync = useCallback(
    (msg: SyncMessage) => {
      if (dataConnection?.open) {
        dataConnection.send(msg);
      }
    },
    [dataConnection],
  );

  return { sendSync };
}
