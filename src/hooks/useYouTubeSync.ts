import { useCallback, useRef } from 'react';
import type { DataConnection } from 'peerjs';
import type { PanelState } from '../types/panels';

/**
 * useYouTubeSync — binds a message handler to a PeerJS DataConnection and
 * exposes a `sendSync` function for broadcasting structured messages to the peer.
 *
 * ## Message routing
 * Two instances of this hook share the same DataConnection (one in Session.tsx,
 * one in YoutubeWidget). PeerJS fires `conn.on("data")` once per connection
 * object, so every message reaches every registered handler. Each instance
 * simply ignores message types it doesn't own.
 *
 * ## Handler stability
 * `onRemoteSync` is stored in a ref so the data event listener never needs to
 * be re-registered when the callback identity changes between renders.
 */

/**
 * All message variants that travel over the WebRTC data channel.
 *
 * - `load` / `play` / `pause` / `seek` — YouTube playback sync (handled by YoutubeWidget)
 * - `panel-update` — panel position/size/z sync; x/y/width/height are viewport fractions 0–1
 *   so they land correctly regardless of each peer's screen resolution
 * - `draw` — a single whiteboard stroke segment; x/y are viewport fractions, width is a
 *   fraction of Math.min(viewportW, viewportH) for DPR-independent sizing
 * - `draw-clear` — clears the whiteboard canvas for both peers
 */
export type SyncMessage =
	| { type: 'load'; videoId: string }
	| { type: 'play'; time: number }
	| { type: 'pause'; time: number }
	| { type: 'seek'; time: number }
	| { type: 'panel-update'; id: string; state: PanelState }
	| {
			type: 'draw';
			x0: number;
			y0: number;
			x1: number;
			y1: number;
			color: string;
			width: number;
	  }
	| { type: 'draw-clear' }
	| { type: 'spawn-youtube'; id: string; videoId?: string; state: PanelState }
	| {
			type: 'spawn-audio';
			id: string;
			state: PanelState;
			fileName?: string;
			mimeType?: string;
			dataB64?: string;
	  }
	| { type: 'remove-panel'; id: string };

interface UseYouTubeSyncOptions {
	dataConnection: DataConnection | null;
	onRemoteSync: (msg: SyncMessage) => void;
}

interface UseYouTubeSyncResult {
	sendSync: (msg: SyncMessage) => void;
}

export function useYouTubeSync({ dataConnection, onRemoteSync }: UseYouTubeSyncOptions): UseYouTubeSyncResult {
	const onRemoteSyncRef = useRef(onRemoteSync);
	onRemoteSyncRef.current = onRemoteSync;

	// Register the data handler when the component mounts/connection changes
	// We use useRef to track if we've already bound the handler
	const boundRef = useRef<DataConnection | null>(null);

	if (dataConnection && boundRef.current !== dataConnection) {
		boundRef.current = dataConnection;
		dataConnection.on('data', raw => {
			onRemoteSyncRef.current(raw as SyncMessage);
		});
	}

	const sendSync = useCallback(
		(msg: SyncMessage) => {
			if (dataConnection?.open) {
				dataConnection.send(msg);
			}
		},
		[dataConnection]
	);

	return { sendSync };
}
