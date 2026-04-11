import { useCallback, useRef } from "react";
import type { DataConnection } from "peerjs";

export type SyncMessage =
  | { type: "load"; videoId: string }
  | { type: "play"; time: number }
  | { type: "pause"; time: number }
  | { type: "seek"; time: number };

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
      console.log(`[SYNC] received from peer:`, raw);
      onRemoteSyncRef.current(raw as SyncMessage);
    });
  }

  const sendSync = useCallback(
    (msg: SyncMessage) => {
      if (dataConnection?.open) {
        console.log(`[SYNC] sending to peer:`, msg);
        dataConnection.send(msg);
      }
    },
    [dataConnection],
  );

  return { sendSync };
}
