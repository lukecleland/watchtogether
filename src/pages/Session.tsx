import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Session — the top-level coordinator for an active watchtogether session.
 *
 * ## Responsibilities
 * - Acquires the local camera/mic stream via `getUserMedia`
 * - Owns all panel layout state (`panels`) and the top-z counter (`topZRef`)
 * - Instantiates `usePeer` to manage the WebRTC connection
 * - Instantiates `useYouTubeSync` to route `panel-update`, `draw`, and
 *   `draw-clear` messages (YouTube playback messages are routed by a second
 *   `useYouTubeSync` instance inside YoutubeWidget)
 * - Normalises panel state before sending and denormalises on receipt so
 *   panels land proportionally on different-resolution screens
 * - Renders the full-screen whiteboard canvas (z=0), the whiteboard toolbar,
 *   and the three floating DraggablePanels (local video, remote video, YouTube)
 * - Owns the dock (`dockedIds`): shared bookmarks that fly the viewport back to
 *   a panel out on the canvas. Tagging and renaming are sent to the peer;
 *   dismissing is local. See the Dock component.
 *
 * ## Panel perspective swap
 * When a `panel-update` arrives for `"local"`, it is applied to `"remote"` and
 * vice versa. This means both users see their own video panel in the same
 * position — dragging "You" on one side moves "Guest" on the other.
 *
 * ## z-order management
 * `topZRef` starts at 20 and is incremented each time a panel is clicked
 * (`bringToFront`). The new z value is written into the panel state and
 * immediately synced to the remote peer.
 */

import { VideoPanel } from '../components/VideoPanel';
import { YoutubeWidget } from '../components/YoutubeWidget';
import { AudioPlayer } from '../components/AudioPlayer';
import { StickyNote } from '../components/StickyNote';
import { BrowserWidget } from '../components/BrowserWidget';
import { CodeWidget } from '../components/CodeWidget';
import { ScreenRecorderWidget, type RecordingStatus } from '../components/ScreenRecorderWidget';
import { ImageWidget } from '../components/ImageWidget';
import { DraggablePanel } from '../components/DraggablePanel';
import { Whiteboard, type ShapeKind, type WhiteboardHandle, type WhiteboardShape, type WhiteboardStroke, type WhiteboardText } from '../components/Whiteboard';
import type { Nib, TextFont } from '../utils/brush';
import { WhiteboardToolbar } from '../components/WhiteboardToolbar';
import { Dock, type DockEntry } from '../components/Dock';
import { SummonButton } from '../components/SummonButton';
import { usePeer } from '../hooks/usePeer';
import { useYouTubeSync, type SyncMessage } from '../hooks/useYouTubeSync';
import type { PanelId, PanelState, DynamicPanel, NoteContent, CodeContent } from '../types/panels';
import { chordsOf, defaultNoteContent } from '../types/panels';
import { TransferReceiver, base64ToChunk, chunkCount, sendFileInChunks } from '../utils/fileTransfer';
import { codeFromText } from '../utils/code';
import { prepareImage } from '../utils/image';
import { parseRoomBundle, serialiseRoomBundle } from '../utils/roomBundle';
import { loadRoomMedia, loadRoomSnapshot, ROOM_STATE_VERSION, saveRoomMedia, saveRoomSnapshot, type PersistedConnector, type RoomSnapshot } from '../utils/roomPersistence';

interface SessionProps {
	roomCode: string;
	isHost: boolean;
}

interface PositionTag {
	id: string;
	x: number;
	y: number;
	label: string;
	/**
	 * Size, in world pixels, when the tag marks an *area* rather than a point.
	 * A point tag can only take you to a spot; one with bounds can frame what
	 * it covers and zoom to fit it — which is the only way to bookmark
	 * handwriting or a drawing, since neither of those is a panel.
	 */
	w?: number;
	h?: number;
}

interface LaserPoint {
	id: string;
	x: number;
	y: number;
	expiresAt: number;
}

interface RemoteCursor {
	x: number;
	y: number;
	updatedAt: number;
	laserPoints: LaserPoint[];
}

const CURSOR_COLOURS = ['#f472b6', '#22d3ee', '#a78bfa', '#34d399', '#fb923c', '#facc15'];

function cursorColour(peerId: string): string {
	let hash = 0;
	for (let index = 0; index < peerId.length; index++) hash = (hash * 31 + peerId.charCodeAt(index)) >>> 0;
	return CURSOR_COLOURS[hash % CURSOR_COLOURS.length];
}

function recordingMetadataFor(panel: DynamicPanel): Array<{ id: string; name: string }> | undefined {
	const metadata = new Map(panel.recordingMetadata?.map(recording => [recording.id, recording]));
	panel.recordings?.forEach(recording => metadata.set(recording.id, { id: recording.id, name: recording.name }));
	return metadata.size ? [...metadata.values()] : undefined;
}

// ── Absolute canvas geometry ─────────────────────────────────────────────
// Panel coordinates and dimensions are world pixels. They must stay absolute:
// scaling width and height by different viewport ratios distorts widgets when
// a mobile client joins or a snapshot is restored on another screen.
function normalisePanel(s: PanelState): PanelState {
	return { ...s };
}

function denormalisePanel(s: PanelState): PanelState {
	return { ...s };
}

// Presentation messages carry the world point at the centre of the viewport,
// rather than screen-space translation. A phone and a desktop can therefore
// follow the same place without requiring identical viewport dimensions.
function presentationView(canvas: { x: number; y: number; scale: number }) {
	return {
		x: (window.innerWidth / 2 - canvas.x) / canvas.scale,
		y: (window.innerHeight / 2 - canvas.y) / canvas.scale,
		scale: canvas.scale
	};
}

function canvasFromPresentation(view: { x: number; y: number; scale: number }) {
	return {
		x: window.innerWidth / 2 - view.x * view.scale,
		y: window.innerHeight / 2 - view.y * view.scale,
		scale: view.scale
	};
}

function panelAnchor(panel: PanelState, toward: PanelState): { x: number; y: number } {
	const x = panel.x + panel.width / 2;
	const y = panel.y + panel.height / 2;
	const dx = toward.x + toward.width / 2 - x;
	const dy = toward.y + toward.height / 2 - y;
	if (dx === 0 && dy === 0) return { x, y };
	const edgeScale = 1 / Math.max(Math.abs(dx) / (panel.width / 2), Math.abs(dy) / (panel.height / 2));
	return { x: x + dx * edgeScale, y: y + dy * edgeScale };
}
// ─────────────────────────────────────────────────────────────────────────

function defaultFixedPanels(): Record<PanelId, PanelState> {
	// Participant feeds default to a compact portrait card. They remain freely
	// resizable, and persisted room geometry still wins when a room is restored.
	const videoW = 236;
	const videoH = 420;
	const topY = 112;
	return {
		local: { x: 460, y: topY, width: videoW, height: videoH, z: 10 },
		remote: { x: 20, y: topY, width: videoW, height: videoH, z: 10 }
	};
}

// The two fixed video panels are mirrored between peers: whoever sends "local"
// means the panel the *receiver* sees as "remote". Dynamic panel ids are shared
// verbatim and pass straight through.
function swapFixedId(id: string): string {
	if (id === 'local') return 'remote';
	if (id === 'remote') return 'local';
	return id;
}

const REMOTE_PANEL_PREFIX = 'remote-peer:';

function remotePanelId(peerId: string): string {
	return `${REMOTE_PANEL_PREFIX}${peerId}`;
}

function peerIdFromPanelId(id: string): string | null {
	return id.startsWith(REMOTE_PANEL_PREFIX) ? id.slice(REMOTE_PANEL_PREFIX.length) : null;
}

// Shared YouTube URL parser (used for background URL drops)
function parseYouTubeVideoId(input: string): string | null {
	try {
		const url = new URL(input.trim());
		const hostname = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
		if (hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
		if (hostname !== 'youtube.com') return null;
		if (url.searchParams.has('v')) return url.searchParams.get('v');
		const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
		if (pathMatch) return pathMatch[1];
	} catch {
		if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
	}
	return null;
}

export function Session({ roomCode, isHost }: SessionProps) {
	const [savedRoom] = useState(() => loadRoomSnapshot(roomCode));
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
	const [cameraEnabled, setCameraEnabled] = useState(true);
	const [mediaError, setMediaError] = useState<string | null>(null);
	const [fixedPanels, setFixedPanels] = useState<Record<PanelId, PanelState>>(() => {
		if (!savedRoom) return defaultFixedPanels();
		// Snapshots written before per-peer participant persistence used `remote`
		// as a cross-client fallback, and that value may contain viewport-scaled
		// corruption. Preserve the user's own panel but reset that unsafe fallback.
		return savedRoom.remotePanels
			? savedRoom.fixedPanels
			: { local: savedRoom.fixedPanels.local, remote: defaultFixedPanels().remote };
	});
	const [remotePanelStates, setRemotePanelStates] = useState<Record<string, PanelState>>(() => savedRoom?.remotePanels ?? {});
	const knownRemoteGeometryRef = useRef(new Set(Object.keys(savedRoom?.remotePanels ?? {})));
	const [dynamicPanels, setDynamicPanels] = useState<DynamicPanel[]>(() => savedRoom?.panels.map(panel => ({
		id: panel.id,
		type: panel.type,
		state: panel.state,
		initialVideoId: panel.initialVideoId,
		initialUrl: panel.initialUrl,
		note: panel.note,
		code: panel.code,
		playback: panel.playback,
		mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : undefined,
		recordingMetadata: panel.recordings,
		recordings: []
	})) ?? []);
	const [positionTags, setPositionTags] = useState<PositionTag[]>(() => savedRoom?.positionTags ?? []);
	const [connectors, setConnectors] = useState<PersistedConnector[]>(() => savedRoom?.connectors ?? []);
	const [connectorStartId, setConnectorStartId] = useState<string | null>(null);
	const positionTagsRef = useRef<PositionTag[]>([]);
	positionTagsRef.current = positionTags;
	// Tracks the highest z-index currently in use so we can raise panels on click
	const topZRef = useRef(Math.max(20, ...(savedRoom?.panels.map(panel => panel.state.z) ?? []), ...(savedRoom ? Object.values(savedRoom.fixedPanels).map(panel => panel.z) : []), ...(savedRoom?.remotePanels ? Object.values(savedRoom.remotePanels).map(panel => panel.z) : [])));
	// Background drag-over indicator
	const [bgDragOver, setBgDragOver] = useState(false);
	// The "nobody here yet" nudge. Dismissing it is final for the session —
	// being told twice how to invite someone is worse than not being told.
	const [summonPromptDismissed, setSummonPromptDismissed] = useState(false);
	const [recorderStatuses, setRecorderStatuses] = useState<Record<string, RecordingStatus>>({});
	const [widgetMenuOpen, setWidgetMenuOpen] = useState(false);
	const widgetMenuRef = useRef<HTMLDivElement>(null);
	const imageInputRef = useRef<HTMLInputElement>(null);
	const roomBundleInputRef = useRef<HTMLInputElement>(null);
	const [bundleNotice, setBundleNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

	// Ref for the outer container div — used to attach native touch listeners
	const containerRef = useRef<HTMLDivElement>(null);
	// Two-touch gesture state for pinch-to-zoom + two-finger pan
	const gestureRef = useRef<{
		lastDist: number;
		lastMid: { x: number; y: number };
	} | null>(null);

	// ── Infinite canvas transform ────────────────────────────────────────────
	const [canvas, setCanvas] = useState(() => savedRoom?.canvas ?? { x: 0, y: 0, scale: 1 });
	const canvasStateRef = useRef({ x: 0, y: 0, scale: 1 });
	canvasStateRef.current = canvas;
	const [isPanMode, setIsPanMode] = useState(false);
	const [isGrabbing, setIsGrabbing] = useState(false);
	const isPanningRef = useRef(false);
	const panStartRef = useRef({ mx: 0, my: 0, cx: 0, cy: 0 });
	const longPressRef = useRef<{
		timer: ReturnType<typeof setTimeout>;
		x: number;
		y: number;
	} | null>(null);

	// ── Dock ─────────────────────────────────────────────────────────────────
	// Panel ids bookmarked in the dock, in the order they were added. Tagging
	// and renaming are shared with the peer (see `dock-tag` / `dock-rename`);
	// dismissing is local, so neither person can clear the other's bar.
	const [dockedIds, setDockedIds] = useState<string[]>(() => savedRoom?.dockedIds ?? []);
	const [minimizedIds, setMinimizedIds] = useState<string[]>([]);
	// ── File transfer ────────────────────────────────────────────────────────
	// Files stream in chunks rather than arriving whole, so a panel can appear
	// immediately and show how far along its contents are.
	const receiverRef = useRef(new TransferReceiver());
	// The live connection, so a transfer can watch the channel's send buffer
	const dataConnectionRef = useRef<unknown>(null);
	const [transferProgress, setTransferProgress] = useState<Record<string, number>>({});
	// transferId -> panelId, so an in-flight transfer can be attributed
	const transferPanelRef = useRef<Record<string, string>>({});
	const pendingPanelForTransfer = (transferId: string) => transferPanelRef.current[transferId];

	// Bookmarks the peer tagged that we haven't acknowledged yet — these pulse.
	const [pulsingIds, setPulsingIds] = useState<string[]>([]);

	useEffect(() => {
		if (!widgetMenuOpen) return;
		const closeIfOutside = (event: MouseEvent | TouchEvent) => {
			if (!widgetMenuRef.current?.contains(event.target as Node)) setWidgetMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setWidgetMenuOpen(false);
		};
		document.addEventListener('mousedown', closeIfOutside);
		document.addEventListener('touchstart', closeIfOutside);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			document.removeEventListener('mousedown', closeIfOutside);
			document.removeEventListener('touchstart', closeIfOutside);
			window.removeEventListener('keydown', closeOnEscape);
		};
	}, [widgetMenuOpen]);
	// Pulse timers, so they can be cleared on acknowledge / unmount
	const pulseTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	// Self-describing label per panel id, used for its dock chip: the YouTube
	// video's title or the audio file's name. Panels report these upward once
	// their content is known, so two YouTube chips aren't indistinguishable.
	const [panelLabels, setPanelLabels] = useState<Record<string, string>>(() => savedRoom?.panelLabels ?? {});
	// User-set chip names. Take precedence over the derived label above, and
	// survive the underlying content changing — if you named it, you meant it.
	const [customLabels, setCustomLabels] = useState<Record<string, string>>(() => savedRoom?.customLabels ?? {});
	// In-flight "fly to panel" animation, so a second jump cancels the first
	const jumpAnimRef = useRef<number | null>(null);
	const pendingViewRequestRef = useRef<string | null>(null);
	const sendSyncRef = useRef<(message: SyncMessage) => void>(() => {});
	const [viewSuggestion, setViewSuggestion] = useState<{ from: string; canvas: { x: number; y: number; scale: number } } | null>(null);
	const [presentationInvite, setPresentationInvite] = useState<{ id: string; presenterPeerId: string; canvas: { x: number; y: number; scale: number } } | null>(null);
	const [presentingId, setPresentingId] = useState<string | null>(null);
	const [following, setFollowing] = useState<{ id: string; presenterPeerId: string } | null>(null);
	const [presentationFollowers, setPresentationFollowers] = useState<string[]>([]);
	const presentationSendRef = useRef<{ lastAt: number; timer: ReturnType<typeof setTimeout> | null }>({ lastAt: 0, timer: null });
	const [laserEnabled, setLaserEnabled] = useState(false);
	const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
	const [localLaserPoints, setLocalLaserPoints] = useState<LaserPoint[]>([]);
	const cursorSendRef = useRef({ lastAt: 0 });

	// Whiteboard
	const whiteboardRef = useRef<WhiteboardHandle>(null);
	const [whiteboardRevision, setWhiteboardRevision] = useState(0);
	const whiteboardSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const markWhiteboardDirty = useCallback(() => {
		if (whiteboardSaveTimerRef.current) clearTimeout(whiteboardSaveTimerRef.current);
		whiteboardSaveTimerRef.current = setTimeout(() => setWhiteboardRevision(value => value + 1), 400);
	}, []);
	const [wbTool, setWbTool] = useState<'pointer' | 'pen' | 'eraser' | 'text' | 'region' | 'shape' | 'connector'>('pointer');
	const [wbShapeKind, setWbShapeKind] = useState<ShapeKind>('rectangle');
	const [wbColor, setWbColor] = useState('#ffffff');
	const [wbWidth, setWbWidth] = useState(3);
	const [wbNib, setWbNib] = useState<Nib>('ballpoint');
	const [wbFont, setWbFont] = useState<TextFont>('sans');
	const [wbTextSize, setWbTextSize] = useState(30);
	// The highlighter keeps its own colour. Sharing the pen's would mean
	// highlighting in white, which does nothing on a dark canvas.
	const [wbHighlightColor, setWbHighlightColor] = useState('#facc15');
	const activeColor = wbNib === 'highlighter' ? wbHighlightColor : wbColor;
	const setActiveColor = (c: string) => (wbNib === 'highlighter' ? setWbHighlightColor(c) : setWbColor(c));
	const latestSnapshotRef = useRef<RoomSnapshot | null>(savedRoom);
	const sendRoomStateRef = useRef<() => void>(() => {});
	const persistedMediaRef = useRef<WeakSet<File>>(new WeakSet());
	const mediaHydratedRef = useRef(!savedRoom);
	const mediaHydrationPromiseRef = useRef<Promise<void>>(Promise.resolve());
	const pendingRoomRequestRef = useRef(false);
	const ignoreLocalHydrationRef = useRef(false);

	useEffect(() => {
		if (savedRoom?.drawings.length) {
			requestAnimationFrame(() => whiteboardRef.current?.replaceItems(savedRoom.drawings));
		}
		if (!savedRoom) return;
		let cancelled = false;
		const hydration = Promise.all(savedRoom.panels.map(async persisted => {
			if (persisted.type === 'audio' && persisted.audioFileName) {
				const file = await loadRoomMedia(roomCode, persisted.id);
				if (!cancelled && !ignoreLocalHydrationRef.current && file) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, initialFile: file } : panel));
			}
			if (persisted.type === 'image' && persisted.imageFileName) {
				const file = await loadRoomMedia(roomCode, persisted.id);
				if (!cancelled && !ignoreLocalHydrationRef.current && file) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, initialFile: file } : panel));
			}
			if (persisted.type === 'recorder' && persisted.recordings?.length) {
				const recordings = (await Promise.all(persisted.recordings.map(async recording => {
					const file = await loadRoomMedia(roomCode, persisted.id, recording.id);
					return file ? { id: recording.id, name: recording.name, file } : null;
				}))).filter(recording => recording !== null);
				if (!cancelled && !ignoreLocalHydrationRef.current) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, recordings } : panel));
			}
		})).then(() => undefined).catch(() => undefined).finally(() => {
			mediaHydratedRef.current = true;
			if (pendingRoomRequestRef.current) {
				pendingRoomRequestRef.current = false;
				setTimeout(() => sendRoomStateRef.current(), 0);
			}
		});
		mediaHydrationPromiseRef.current = hydration;
		void hydration;
		return () => { cancelled = true; };
	}, [roomCode, savedRoom, savedRoom?.panels]);

	useEffect(() => {
		const snapshot: RoomSnapshot = {
			version: ROOM_STATE_VERSION,
			savedAt: Date.now(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			fixedPanels,
			remotePanels: remotePanelStates,
			panels: dynamicPanels.map(panel => ({
				id: panel.id,
				type: panel.type,
				state: panel.state,
				initialVideoId: panel.initialVideoId,
				initialUrl: panel.initialUrl,
				note: panel.note,
				code: panel.code,
				audioFileName: panel.type === 'audio' ? panel.initialFile?.name ?? panel.mediaFileName ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.audioFileName : undefined,
				imageFileName: panel.type === 'image' ? panel.initialFile?.name ?? panel.mediaFileName ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.imageFileName : undefined,
				recordings: recordingMetadataFor(panel) ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.recordings,
				playback: panel.playback
			})),
			drawings: whiteboardRef.current?.getItems() ?? savedRoom?.drawings ?? [],
			positionTags,
			connectors,
			dockedIds,
			panelLabels,
			customLabels,
			canvas
		};
		latestSnapshotRef.current = snapshot;
		const saveTimer = setTimeout(() => saveRoomSnapshot(roomCode, snapshot), 250);
		dynamicPanels.forEach(panel => {
			if (panel.initialFile && !persistedMediaRef.current.has(panel.initialFile)) {
				persistedMediaRef.current.add(panel.initialFile);
				void saveRoomMedia(roomCode, panel.id, panel.initialFile).catch(() => {});
			}
			panel.recordings?.forEach(recording => {
				if (persistedMediaRef.current.has(recording.file)) return;
				persistedMediaRef.current.add(recording.file);
				void saveRoomMedia(roomCode, panel.id, recording.file, recording.id).catch(() => {});
			});
		});
		return () => clearTimeout(saveTimer);
	}, [canvas, connectors, customLabels, dockedIds, dynamicPanels, fixedPanels, panelLabels, positionTags, remotePanelStates, roomCode, savedRoom?.drawings, savedRoom?.panels, whiteboardRevision]);

	const { remoteStreams, dataConnection, participantCount, status, error, replaceVideoTrack } = usePeer({
		roomCode,
		isHost,
		localStream
	});
	dataConnectionRef.current = dataConnection;

	useEffect(() => {
		setRemotePanelStates(prev => {
			// Retain disconnected peers so a transient reconnect with the same id
			// cannot discard its persisted size before the stream returns.
			const next: Record<string, PanelState> = { ...prev };
			remoteStreams.forEach(({ peerId }, index) => {
				next[peerId] =
					prev[peerId] ?? {
						...fixedPanels.remote,
						x: fixedPanels.remote.x + index * 28,
						y: fixedPanels.remote.y + index * 28,
						z: fixedPanels.remote.z + index
					};
			});
			return next;
		});
	}, [remoteStreams, fixedPanels.remote]);

	// The video panels are docked from the start, so however far someone wanders
	// the canvas there is always a chip back to the faces. Purely local — each
	// side seeds its own chips, so nothing travels and nothing pulses.
	useEffect(() => {
		// Guarded on tracks like the panel itself: someone who joined without
		// media has no "You" panel, so a chip to it would jump to empty canvas.
		if (localStream && localStream.getTracks().length > 0) {
			setDockedIds(prev => (prev.includes('local') ? prev : [...prev, 'local']));
		}
	}, [localStream]);
	// One chip per guest, seeded once when that peer first appears — the seen
	// set means another peer joining later can't resurrect a chip that was
	// deliberately dismissed, and a peer who leaves takes their chip with them
	// (dockEntriesFor drops ids with no matching stream).
	const seededPeerChipsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const newcomers = remoteStreams
			.map(remote => remote.peerId)
			.filter(peerId => !seededPeerChipsRef.current.has(peerId));
		if (newcomers.length === 0) return;
		newcomers.forEach(peerId => seededPeerChipsRef.current.add(peerId));
		setDockedIds(prev => [...prev, ...newcomers.map(remotePanelId).filter(id => !prev.includes(id))]);
	}, [remoteStreams]);

	// Stop a chip pulsing — it's been seen
	const acknowledgePulse = useCallback((id: string) => {
		const timer = pulseTimersRef.current[id];
		if (timer) {
			clearTimeout(timer);
			delete pulseTimersRef.current[id];
		}
		setPulsingIds(prev => (prev.includes(id) ? prev.filter(p => p !== id) : prev));
	}, []);

	// Start a chip pulsing, and stop it on its own after a while so a bookmark
	// nobody clicks doesn't pulse for the rest of the session.
	const startPulse = useCallback(
		(id: string) => {
			setPulsingIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			if (pulseTimersRef.current[id]) clearTimeout(pulseTimersRef.current[id]);
			pulseTimersRef.current[id] = setTimeout(() => acknowledgePulse(id), 10000);
		},
		[acknowledgePulse]
	);

	// Any z arriving from the peer has to push our own counter up. Without this
	// the counters drift apart: they raise a panel to 21, we still think the top
	// is 20, and the next panel we spawn is handed 21 as well — a tie that leaves
	// it level with or behind theirs, and if it lands over the top of one it
	// can't be clicked at all.
	const noteRemoteZ = useCallback((z: number) => {
		if (Number.isFinite(z) && z > topZRef.current) topZRef.current = z;
	}, []);

	// Drop any dock chip / cached label belonging to a panel that no longer exists
	const forgetPanel = useCallback((id: string) => {
		setDockedIds(prev => (prev.includes(id) ? prev.filter(d => d !== id) : prev));
		setPanelLabels(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		setCustomLabels(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		acknowledgePulse(id);
	}, [acknowledgePulse]);

	const applyRoomSnapshot = useCallback((snapshot: RoomSnapshot) => {
		ignoreLocalHydrationRef.current = true;
		// Participant panels are perspective-specific. Keep this client's locally
		// persisted self/peer geometry; live panel announcements repopulate peers.
		setDynamicPanels(snapshot.panels.map(panel => ({
			id: panel.id,
			type: panel.type,
			state: { ...panel.state },
			initialVideoId: panel.initialVideoId,
			initialUrl: panel.initialUrl,
			note: panel.note,
			code: panel.code,
			playback: panel.playback,
			mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : undefined,
			recordingMetadata: panel.recordings,
			recordings: []
		})));
		setPositionTags(snapshot.positionTags.map(tag => ({ ...tag })));
		setConnectors(snapshot.connectors?.map(connector => ({ ...connector })) ?? []);
		setDockedIds(snapshot.dockedIds.map(swapFixedId));
		setPanelLabels(snapshot.panelLabels);
		setCustomLabels(Object.fromEntries(Object.entries(snapshot.customLabels).map(([id, label]) => [swapFixedId(id), label])));
		setCanvas({ ...snapshot.canvas });
		whiteboardRef.current?.replaceItems(snapshot.drawings);
		// The normal persistence effect writes the merged local perspective. Do
		// not store the host snapshot verbatim or it will replace this client's
		// participant geometry on the next refresh.
	}, []);

	const applyPortableSnapshot = useCallback((snapshot: RoomSnapshot) => {
		const panels: DynamicPanel[] = snapshot.panels.map(panel => ({
			id: panel.id,
			type: panel.type,
			state: { ...panel.state },
			initialVideoId: panel.initialVideoId,
			initialUrl: panel.initialUrl,
			note: panel.note,
			code: panel.code,
			playback: panel.playback,
			mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : undefined,
			recordingMetadata: panel.recordings,
			recordings: []
		}));
		const sharedIds = new Set([...panels.map(panel => panel.id), ...snapshot.positionTags.map(tag => tag.id)]);
		const onlySharedLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).filter(([id]) => sharedIds.has(id)));
		const scale = Math.max(0.25, Math.min(4, snapshot.canvas.scale));
		const sourceWidth = Math.max(1, snapshot.viewport.width);
		const sourceHeight = Math.max(1, snapshot.viewport.height);
		const centreX = (sourceWidth / 2 - snapshot.canvas.x) / scale;
		const centreY = (sourceHeight / 2 - snapshot.canvas.y) / scale;

		setDynamicPanels(panels);
		setPositionTags(snapshot.positionTags.map(tag => ({ ...tag })));
		setConnectors((snapshot.connectors ?? []).filter(connector => sharedIds.has(connector.fromPanelId) && sharedIds.has(connector.toPanelId)).map(connector => ({ ...connector })));
		setDockedIds(snapshot.dockedIds.filter(id => sharedIds.has(id)));
		setPanelLabels(onlySharedLabels(snapshot.panelLabels));
		setCustomLabels(onlySharedLabels(snapshot.customLabels));
		setCanvas({ x: window.innerWidth / 2 - centreX * scale, y: window.innerHeight / 2 - centreY * scale, scale });
		receiverRef.current.clear();
		transferPanelRef.current = {};
		setTransferProgress({});
		setRecorderStatuses({});
		whiteboardRef.current?.replaceItems(snapshot.drawings);
		setWhiteboardRevision(revision => revision + 1);
		topZRef.current = Math.max(20, ...panels.map(panel => panel.state.z));

		// Bundles intentionally omit media bytes. If this browser still has files
		// for the same room and panel ids, quietly reconnect them after restore.
		void Promise.all(snapshot.panels.map(async panel => {
			if ((panel.type === 'audio' && panel.audioFileName) || (panel.type === 'image' && panel.imageFileName)) {
				const file = await loadRoomMedia(roomCode, panel.id).catch(() => null);
				if (file) setDynamicPanels(previous => previous.map(item => item.id === panel.id ? { ...item, initialFile: file } : item));
			}
			if (panel.type === 'recorder' && panel.recordings?.length) {
				const recordings = (await Promise.all(panel.recordings.map(async recording => {
					const file = await loadRoomMedia(roomCode, panel.id, recording.id).catch(() => null);
					return file ? { id: recording.id, name: recording.name, file } : null;
				}))).filter(recording => recording !== null);
				if (recordings.length) setDynamicPanels(previous => previous.map(item => item.id === panel.id ? { ...item, recordings } : item));
			}
		}));
	}, [roomCode]);

	// Panel sync — wired to the same data channel as YouTube sync
	const handleRemoteSync = useCallback((msg: SyncMessage) => {
		const sourcePeerId = (msg as SyncMessage & { __meshSourcePeerId?: string }).__meshSourcePeerId;
		if (msg.type === 'presentation-invite') {
			if (sourcePeerId && msg.id !== presentingId) setPresentationInvite({ id: msg.id, presenterPeerId: sourcePeerId, canvas: canvasFromPresentation(msg.canvas) });
			return;
		}
		if (msg.type === 'presentation-accept') {
			if (msg.id === presentingId && sourcePeerId) setPresentationFollowers(previous => previous.includes(sourcePeerId) ? previous : [...previous, sourcePeerId]);
			return;
		}
		if (msg.type === 'presentation-leave') {
			if (msg.id === presentingId && sourcePeerId) setPresentationFollowers(previous => previous.filter(peerId => peerId !== sourcePeerId));
			return;
		}
		if (msg.type === 'presentation-view') {
			if (following?.id === msg.id && following.presenterPeerId === sourcePeerId) setCanvas(canvasFromPresentation(msg.canvas));
			return;
		}
		if (msg.type === 'presentation-stop') {
			if (following?.id === msg.id && following.presenterPeerId === sourcePeerId) setFollowing(null);
			if (presentationInvite?.id === msg.id && presentationInvite.presenterPeerId === sourcePeerId) setPresentationInvite(null);
			return;
		}
		if (msg.type === 'cursor-move') {
			if (!sourcePeerId) return;
			const now = Date.now();
			setRemoteCursors(previous => {
				const current = previous[sourcePeerId];
				const laserPoints = msg.laser
					? [...(current?.laserPoints.filter(point => point.expiresAt > now) ?? []), { id: crypto.randomUUID(), x: msg.x, y: msg.y, expiresAt: now + 900 }].slice(-32)
					: current?.laserPoints ?? [];
				return { ...previous, [sourcePeerId]: { x: msg.x, y: msg.y, updatedAt: now, laserPoints } };
			});
			return;
		}
		if (msg.type === 'cursor-leave') {
			if (!sourcePeerId) return;
			setRemoteCursors(previous => {
				if (!(sourcePeerId in previous)) return previous;
				const next = { ...previous };
				delete next[sourcePeerId];
				return next;
			});
			return;
		}
		if (msg.type === 'room-state-request') {
			if (isHost) sendRoomStateRef.current();
			return;
		}
		if (msg.type === 'room-state-snapshot') {
			if (!isHost) applyRoomSnapshot(msg.snapshot);
			return;
		}
		if (msg.type === 'room-state-import') {
			applyPortableSnapshot(msg.snapshot);
			setBundleNotice({ kind: 'success', message: 'A participant restored a room bundle.' });
			return;
		}
		if (msg.type === 'view-request') {
			if (msg.id === 'local') {
				const current = canvasStateRef.current;
				sendSyncRef.current({ type: 'view-response', id: 'local', canvas: { ...current } });
			}
			return;
		}
		if (msg.type === 'view-response') {
			if (pendingViewRequestRef.current === msg.id) {
				pendingViewRequestRef.current = null;
				setCanvas({ ...msg.canvas });
			}
			return;
		}
		if (msg.type === 'view-suggestion') {
			setViewSuggestion({ from: msg.id, canvas: msg.canvas });
			return;
		}
		if (msg.type === 'connector-add') {
			setConnectors(previous => previous.some(connector => connector.id === msg.connector.id) ? previous : [...previous, msg.connector]);
			return;
		}
		if (msg.type === 'connector-remove') {
			setConnectors(previous => previous.filter(connector => connector.id !== msg.id));
			return;
		}
		// Every message that carries panel geometry carries a z with it
		if ('state' in msg) noteRemoteZ(msg.state.z);
		if (msg.type.startsWith('spawn-') && 'id' in msg) {
			setDockedIds(prev => (prev.includes(msg.id) ? prev : [...prev, msg.id]));
		}

		if (msg.type === 'panel-announce') {
			const remotePeerId = peerIdFromPanelId(msg.id);
			if (remotePeerId && !knownRemoteGeometryRef.current.has(remotePeerId)) {
				knownRemoteGeometryRef.current.add(remotePeerId);
				setRemotePanelStates(prev => ({ ...prev, [remotePeerId]: denormalisePanel(msg.state) }));
			}
		} else if (msg.type === 'panel-update') {
			const remotePeerId = peerIdFromPanelId(msg.id);
			if (remotePeerId) {
				knownRemoteGeometryRef.current.add(remotePeerId);
				setRemotePanelStates(prev => ({
					...prev,
					[remotePeerId]: denormalisePanel(msg.state)
				}));
			} else if (msg.id === 'local' || msg.id === 'remote') {
				// usePeer has already translated a targeted remote-peer id to local.
				// Swapping again corrupts the fallback dimensions used after refresh.
				const targetId: PanelId = msg.id;
				setFixedPanels(prev => ({
					...prev,
					[targetId]: denormalisePanel(msg.state)
				}));
			} else {
				// Dynamic panel — update by id if it exists
				setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, state: denormalisePanel(msg.state) } : p)));
			}
		} else if (msg.type === 'spawn-youtube') {
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'youtube' as const,
					state: denormalisePanel(msg.state),
					...(msg.videoId ? { initialVideoId: msg.videoId } : {})
				}
			]);
		} else if (msg.type === 'spawn-browser') {
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'browser' as const,
					state: denormalisePanel(msg.state),
					...(msg.url ? { initialUrl: msg.url } : {})
				}
			]);
		} else if (msg.type === 'spawn-image') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'image', state: denormalisePanel(msg.state) }]);
		} else if (msg.type === 'spawn-audio') {
			// Older builds inlined the whole file here; newer ones stream it
			// separately, so the panel arrives empty and fills in.
			let initialFile: File | undefined;
			if (msg.dataB64 && msg.fileName && msg.mimeType) {
				initialFile = new File([base64ToChunk(msg.dataB64)], msg.fileName, { type: msg.mimeType });
			}
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'audio' as const,
					state: denormalisePanel(msg.state),
					...(initialFile ? { initialFile } : {})
				}
			]);
		} else if (msg.type === 'spawn-note') {
			setDynamicPanels(prev => [
				...prev,
				{ id: msg.id, type: 'note' as const, state: denormalisePanel(msg.state), note: msg.note }
			]);
		} else if (msg.type === 'note-update') {
			// Last write wins — a note is small enough that merging isn't worth it
			setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, note: msg.note } : p)));
		} else if (msg.type === 'spawn-code') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'code', state: denormalisePanel(msg.state), code: msg.code }]);
		} else if (msg.type === 'code-update') {
			setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, code: msg.code } : p)));
		} else if (msg.type === 'spawn-recorder') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'recorder', state: denormalisePanel(msg.state), recordings: [] }]);
		} else if (msg.type === 'remove-panel') {
			setDynamicPanels(prev => prev.filter(p => p.id !== msg.id));
			setConnectors(prev => prev.filter(connector => connector.fromPanelId !== msg.id && connector.toPanelId !== msg.id));
			setConnectorStartId(previous => previous === msg.id ? null : previous);
			// The panel is gone, so any local dock chip pointing at it must go too
			forgetPanel(msg.id);
		} else if (msg.type === 'position-tag') {
			const tag: PositionTag = {
				...(msg.w !== undefined && msg.h !== undefined
					? { w: msg.w, h: msg.h }
					: {}),
				id: msg.id,
				x: msg.x,
				y: msg.y,
				label: msg.label
			};
			setPositionTags(prev => (prev.some(item => item.id === tag.id) ? prev : [...prev, tag]));
			setDockedIds(prev => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
			startPulse(tag.id);
		} else if (msg.type === 'position-tag-remove') {
			setPositionTags(prev => prev.filter(tag => tag.id !== msg.id));
			forgetPanel(msg.id);
		} else if (msg.type === 'dock-tag') {
			// Same perspective swap as panel-update: their "You" is our "Guest"
			const id = swapFixedId(msg.id);
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			// Only custom names travel; automatic labels are derived identically
			// on both sides, and for video panels the derived name is the
			// correct one for whichever side is looking.
			if (msg.label) setCustomLabels(prev => ({ ...prev, [id]: msg.label as string }));
			startPulse(id);
		} else if (msg.type === 'dock-ping') {
			const id = swapFixedId(msg.id);
			// A ping is an explicit "look here", so it re-adds a bookmark the
			// receiver had dismissed rather than failing silently on their side.
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			startPulse(id);
		} else if (msg.type === 'dock-rename') {
			const id = swapFixedId(msg.id);
			setCustomLabels(prev => {
				if (!msg.label) {
					if (!(id in prev)) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				}
				return { ...prev, [id]: msg.label };
			});
		} else if (msg.type === 'file-begin') {
			transferPanelRef.current[msg.transferId] = msg.panelId;
			receiverRef.current.begin(msg);
			setTransferProgress(prev => ({ ...prev, [msg.panelId]: 0 }));
		} else if (msg.type === 'file-chunk') {
			const done = receiverRef.current.accept(msg.transferId, msg.index, msg.data);
			if (done) {
				delete transferPanelRef.current[msg.transferId];
				if (!done.meta.recordingId) setPanelLabels(prev => ({ ...prev, [done.meta.panelId]: done.file.name }));
				setDynamicPanels(prev => prev.map(p => {
					if (p.id !== done.meta.panelId) return p;
					if (done.meta.recordingId) {
						if (p.recordings?.some(recording => recording.id === done.meta.recordingId)) return p;
						return { ...p, recordings: [...(p.recordings ?? []), { id: done.meta.recordingId, name: done.file.name, file: done.file }] };
					}
					return { ...p, initialFile: done.file, mediaFileName: done.file.name };
				}));
				setTransferProgress(prev => {
					const next = { ...prev };
					delete next[done.meta.panelId];
					return next;
				});
			} else {
				const panelId = pendingPanelForTransfer(msg.transferId);
				if (panelId) {
					const p = receiverRef.current.progressFor(panelId);
					if (p !== null) setTransferProgress(prev => ({ ...prev, [panelId]: p }));
				}
			}
		} else if (msg.type === 'file-abort') {
			receiverRef.current.abort(msg.transferId);
		} else if (msg.type === 'draw') {
			whiteboardRef.current?.drawStroke(msg);
			markWhiteboardDirty();
		} else if (msg.type === 'draw-shape') {
			whiteboardRef.current?.drawShape(msg.shape);
			markWhiteboardDirty();
		} else if (msg.type === 'draw-text') {
			whiteboardRef.current?.drawText({ ...msg, kind: 'text', id: msg.id, font: msg.font as TextFont });
			markWhiteboardDirty();
		} else if (msg.type === 'text-edit') {
			whiteboardRef.current?.editText(msg.id, msg.text);
			markWhiteboardDirty();
		} else if (msg.type === 'text-move') {
			whiteboardRef.current?.moveText(msg.id, msg.x, msg.y);
			markWhiteboardDirty();
		} else if (msg.type === 'draw-clear') {
			whiteboardRef.current?.clearCanvas();
			setConnectors([]);
			markWhiteboardDirty();
		}
	}, [applyPortableSnapshot, applyRoomSnapshot, following, forgetPanel, isHost, markWhiteboardDirty, noteRemoteZ, presentationInvite, presentingId, startPulse]);

	// We use useYouTubeSync here to route panel-update and whiteboard messages.
	// YoutubeWidget mounts its own useYouTubeSync instance for YT playback messages.
	const { sendSync } = useYouTubeSync({
		dataConnection,
		onRemoteSync: handleRemoteSync
	});
	sendSyncRef.current = sendSync;

	const startPresenting = useCallback(() => {
		if (participantCount < 2) return;
		const id = crypto.randomUUID();
		if (following) sendSync({ type: 'presentation-leave', id: following.id });
		setFollowing(null);
		setPresentationInvite(null);
		setPresentationFollowers([]);
		setPresentingId(id);
		const current = canvasStateRef.current;
		sendSync({ type: 'presentation-invite', id, canvas: presentationView(current) });
	}, [following, participantCount, sendSync]);

	const stopPresenting = useCallback(() => {
		if (!presentingId) return;
		sendSync({ type: 'presentation-stop', id: presentingId });
		setPresentingId(null);
		setPresentationFollowers([]);
	}, [presentingId, sendSync]);

	const acceptPresentation = useCallback(() => {
		if (!presentationInvite) return;
		if (presentingId) sendSync({ type: 'presentation-stop', id: presentingId });
		if (following) sendSync({ type: 'presentation-leave', id: following.id });
		setPresentingId(null);
		setPresentationFollowers([]);
		setFollowing({ id: presentationInvite.id, presenterPeerId: presentationInvite.presenterPeerId });
		setCanvas({ ...presentationInvite.canvas });
		sendSync({ type: 'presentation-accept', id: presentationInvite.id });
		setPresentationInvite(null);
	}, [following, presentationInvite, presentingId, sendSync]);

	const stopFollowing = useCallback(() => {
		if (!following) return;
		sendSync({ type: 'presentation-leave', id: following.id });
		setFollowing(null);
	}, [following, sendSync]);

	// Viewport updates are intentionally throttled: panning can produce a state
	// update for every pointer event, while presentation feels smooth at 12fps.
	useEffect(() => {
		if (!presentingId) return;
		const sender = presentationSendRef.current;
		const sendView = () => {
			sender.lastAt = Date.now();
			sender.timer = null;
			sendSync({ type: 'presentation-view', id: presentingId, canvas: presentationView(canvasStateRef.current) });
		};
		const remaining = 80 - (Date.now() - sender.lastAt);
		if (remaining <= 0) sendView();
		else if (!sender.timer) sender.timer = setTimeout(sendView, remaining);
	}, [canvas, presentingId, sendSync]);

	useEffect(() => () => {
		if (presentationSendRef.current.timer) clearTimeout(presentationSendRef.current.timer);
	}, []);

	useEffect(() => {
		if (participantCount > 1) return;
		setFollowing(null);
		setPresentationInvite(null);
		setPresentingId(null);
		setPresentationFollowers([]);
	}, [participantCount]);

	const broadcastCursor = useCallback((clientX: number, clientY: number) => {
		const now = Date.now();
		if (now - cursorSendRef.current.lastAt < 40) return;
		cursorSendRef.current.lastAt = now;
		const current = canvasStateRef.current;
		const x = (clientX - current.x) / current.scale;
		const y = (clientY - current.y) / current.scale;
		sendSync({ type: 'cursor-move', x, y, laser: laserEnabled });
		if (laserEnabled) {
			setLocalLaserPoints(previous => [...previous.filter(point => point.expiresAt > now), { id: crypto.randomUUID(), x, y, expiresAt: now + 900 }].slice(-32));
		}
	}, [laserEnabled, sendSync]);

	useEffect(() => {
		const timer = setInterval(() => {
			const now = Date.now();
			setLocalLaserPoints(previous => {
				const next = previous.filter(point => point.expiresAt > now);
				return next.length === previous.length ? previous : next;
			});
			setRemoteCursors(previous => {
				let changed = false;
				const next: Record<string, RemoteCursor> = {};
				for (const [peerId, cursor] of Object.entries(previous)) {
					if (now - cursor.updatedAt > 10_000) {
						changed = true;
						continue;
					}
					const laserPoints = cursor.laserPoints.filter(point => point.expiresAt > now);
					if (laserPoints.length !== cursor.laserPoints.length) changed = true;
					next[peerId] = laserPoints === cursor.laserPoints ? cursor : { ...cursor, laserPoints };
				}
				return changed ? next : previous;
			});
		}, 200);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const toggleLaser = (event: KeyboardEvent) => {
			if (event.repeat || event.key.toLowerCase() !== 'l' || (event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
			setLaserEnabled(enabled => !enabled);
		};
		window.addEventListener('keydown', toggleLaser);
		return () => window.removeEventListener('keydown', toggleLaser);
	}, []);

	const exportRoomBundle = useCallback(() => {
		const current = latestSnapshotRef.current;
		if (!current) {
			setBundleNotice({ kind: 'error', message: 'The room is still being prepared. Try exporting again in a moment.' });
			return;
		}
		const snapshot: RoomSnapshot = {
			...current,
			savedAt: Date.now(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			canvas: { ...canvasStateRef.current },
			drawings: whiteboardRef.current?.getItems() ?? current.drawings
		};
		const blob = new Blob([serialiseRoomBundle(snapshot)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `watchtogether-${roomCode.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
		setBundleNotice({ kind: 'success', message: 'Room bundle exported. Media files remain stored only in this browser.' });
	}, [roomCode]);

	const importRoomBundle = useCallback(async (file: File) => {
		try {
			if (file.size > 20 * 1024 * 1024) throw new Error('Room bundles must be smaller than 20 MB.');
			const snapshot = parseRoomBundle(await file.text());
			applyPortableSnapshot(snapshot);
			sendSync({ type: 'room-state-import', snapshot });
			setBundleNotice({ kind: 'success', message: 'Room restored. Media metadata was imported; media files remain local to their original browser.' });
		} catch (error) {
			setBundleNotice({ kind: 'error', message: error instanceof Error ? error.message : 'The room bundle could not be imported.' });
		}
	}, [applyPortableSnapshot, sendSync]);

	useEffect(() => {
		if (!bundleNotice) return;
		const timer = setTimeout(() => setBundleNotice(null), 7000);
		return () => clearTimeout(timer);
	}, [bundleNotice]);

	const sendPanelUpdate = useCallback(
		(id: string, state: PanelState) => {
			sendSync({ type: 'panel-update', id, state: normalisePanel(state) });
		},
		[sendSync]
	);

	const handleWbStroke = useCallback(
		(stroke: WhiteboardStroke) => {
			sendSync({ type: 'draw', ...stroke });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbShape = useCallback(
		(shape: WhiteboardShape) => {
			sendSync({ type: 'draw-shape', shape });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbText = useCallback(
		(item: WhiteboardText) => {
			sendSync({ type: 'draw-text', id: item.id, x: item.x, y: item.y, text: item.text, color: item.color, size: item.size, font: item.font });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbTextEdit = useCallback(
		(id: string, text: string) => {
			sendSync({ type: 'text-edit', id, text });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);
	const handleWbTextMove = useCallback(
		(id: string, x: number, y: number) => {
			sendSync({ type: 'text-move', id, x, y });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	// A dragged-out area becomes a tag with bounds, so it can frame what it
	// covers — the only way to bookmark strokes or text, neither being a panel.
	const handleWbRegion = useCallback(
		(r: { x: number; y: number; w: number; h: number }) => {
			const id = crypto.randomUUID();
			const tag: PositionTag = {
				id,
				x: r.x * window.innerWidth,
				y: r.y * window.innerHeight,
				w: r.w,
				h: r.h,
				label: `Area ${positionTagsRef.current.length + 1}`
			};
			setPositionTags(prev => [...prev, tag]);
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			// Everything travels world-normalised (world pixels ÷ this viewport),
			// like strokes and the long-press point tag — the receiver scales back
			// up by its own viewport. `r` is already in those units; `tag` holds
			// the local world-pixel version, and sending that instead is exactly
			// the mistake that threw the peer's viewport off the canvas.
			sendSync({
				type: 'position-tag',
				id,
				x: tag.x,
				y: tag.y,
				w: tag.w,
				h: tag.h,
				label: tag.label
			});
		},
		[sendSync]
	);

	// Stream a file to the peer for an already-spawned panel
	const sendFileTo = useCallback(
		(panelId: string, file: File, recordingId?: string) => {
			const transferId = crypto.randomUUID();
			transferPanelRef.current[transferId] = panelId;
			sendSync({
				type: 'file-begin',
				transferId,
				panelId,
				fileName: file.name,
				mimeType: file.type,
				size: file.size,
				chunks: chunkCount(file.size),
				...(recordingId ? { recordingId } : {})
			});
			setTransferProgress(prev => ({ ...prev, [panelId]: 0 }));
			void sendFileInChunks(
				file,
				dataConnectionRef.current,
				({ index, data }) => sendSync({ type: 'file-chunk', transferId, index, data }),
				fraction => {
					setTransferProgress(prev => ({ ...prev, [panelId]: fraction }));
					if (fraction >= 1) {
						delete transferPanelRef.current[transferId];
						setTransferProgress(prev => {
							const next = { ...prev };
							delete next[panelId];
							return next;
						});
					}
				}
			);
		},
		[sendSync]
	);

	useEffect(() => {
		sendRoomStateRef.current = () => {
			if (!mediaHydratedRef.current) {
				pendingRoomRequestRef.current = true;
				void mediaHydrationPromiseRef.current;
				return;
			}
			const snapshot = latestSnapshotRef.current;
			if (!snapshot) return;
			sendSync({ type: 'room-state-snapshot', snapshot });
			dynamicPanels.forEach(panel => {
				if (panel.initialFile) sendFileTo(panel.id, panel.initialFile);
				panel.recordings?.forEach(recording => sendFileTo(panel.id, recording.file, recording.id));
			});
		};
	}, [dynamicPanels, sendFileTo, sendSync]);

	useEffect(() => {
		if (!isHost && status === 'connected') sendSync({ type: 'room-state-request' });
	}, [isHost, sendSync, status]);

	useEffect(() => {
		if (status === 'connected') sendSync({ type: 'panel-announce', id: 'local', state: normalisePanel(fixedPanels.local) });
	}, [fixedPanels.local, sendSync, status]);

	const handleWbClear = useCallback(() => {
		whiteboardRef.current?.clearCanvas();
		setConnectors([]);
		setConnectorStartId(null);
		sendSync({ type: 'draw-clear' });
		markWhiteboardDirty();
	}, [markWhiteboardDirty, sendSync]);

	const bringToFront = useCallback(
		(id: PanelId) => {
			const nextZ = ++topZRef.current;
			setFixedPanels(prev => {
				const next = { ...prev, [id]: { ...prev[id], z: nextZ } };
				sendPanelUpdate(id, next[id]);
				return next;
			});
		},
		[sendPanelUpdate]
	);

	const makePanelHandlers = (id: PanelId) => ({
		onLocalUpdate: (next: PanelState) => setFixedPanels(prev => ({ ...prev, [id]: next })),
		onSyncUpdate: (next: PanelState) => sendPanelUpdate(id, next),
		onBringToFront: () => bringToFront(id)
	});

	const makeDynamicPanelHandlers = (id: string) => ({
		onLocalUpdate: (next: PanelState) => setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, state: next } : p))),
		onSyncUpdate: (next: PanelState) => sendPanelUpdate(id, next),
		onBringToFront: () => {
			const nextZ = ++topZRef.current;
			const panel = dynamicPanels.find(p => p.id === id);
			setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, state: { ...p.state, z: nextZ } } : p)));
			// Fixed panels already sync their raise. Spawned ones only did so by
			// accident, via the drag-stop that usually follows a pointer-down —
			// so raising one by clicking a control inside it stayed local.
			// The send sits outside the state updater; StrictMode runs updaters
			// twice, which would send it twice.
			if (panel) sendPanelUpdate(id, { ...panel.state, z: nextZ });
		}
	});

	const removePanel = (id: string) => {
		const attached = connectors.filter(connector => connector.fromPanelId === id || connector.toPanelId === id);
		setConnectors(prev => prev.filter(connector => connector.fromPanelId !== id && connector.toPanelId !== id));
		attached.forEach(connector => sendSync({ type: 'connector-remove', id: connector.id }));
		setConnectorStartId(previous => previous === id ? null : previous);
		setDynamicPanels(prev => prev.filter(p => p.id !== id));
		setRecorderStatuses(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		forgetPanel(id);
		sendSync({ type: 'remove-panel', id });
	};

	const selectConnectorPanel = useCallback((id: string) => {
		if (!connectorStartId) {
			setConnectorStartId(id);
			return;
		}
		if (connectorStartId === id) {
			setConnectorStartId(null);
			return;
		}
		const connector: PersistedConnector = {
			id: crypto.randomUUID(),
			fromPanelId: connectorStartId,
			toPanelId: id,
			color: activeColor,
			width: wbWidth
		};
		setConnectors(previous => [...previous, connector]);
		sendSync({ type: 'connector-add', connector });
		setConnectorStartId(null);
	}, [activeColor, connectorStartId, sendSync, wbWidth]);

	const removeConnector = useCallback((id: string) => {
		setConnectors(previous => previous.filter(connector => connector.id !== id));
		sendSync({ type: 'connector-remove', id });
	}, [sendSync]);

	useEffect(() => {
		if (wbTool !== 'connector') setConnectorStartId(null);
	}, [wbTool]);

	// The video panels are permanent anchors — you can always get back to a
	// face. Their chips carry no delete button, and this guard backs that up
	// so no other path (panel bookmark, double-click) can un-dock one either.
	const isParticipantId = (id: string) =>
		id === 'local' || id === 'remote' || peerIdFromPanelId(id) !== null;

	// Tagging is shared; untagging is not. Removing a chip clears it from your
	// own bar only — nobody gets to delete a bookmark out of the other's UI.
	const toggleDock = (id: string) => {
		// The send stays outside the state updater — StrictMode invokes updaters
		// twice, which would tag the peer twice.
		if (dockedIds.includes(id)) {
			if (isParticipantId(id)) return;
			acknowledgePulse(id);
			setDockedIds(prev => prev.filter(d => d !== id));
			return;
		}
		sendSync({ type: 'dock-tag', id, ...(customLabels[id] ? { label: customLabels[id] } : {}) });
		setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
	};

	const removeDockEntry = (id: string) => {
		if (minimizedIds.includes(id)) return;
		if (positionTags.some(tag => tag.id === id)) {
			setPositionTags(prev => prev.filter(tag => tag.id !== id));
			forgetPanel(id);
			sendSync({ type: 'position-tag-remove', id });
			return;
		}
		toggleDock(id);
	};

	const dockElementFor = (id: string) => document.querySelector<HTMLElement>(`[data-dock-entry="${CSS.escape(id)}"]`);
	const panelShellFor = (id: string) => document.querySelector<HTMLElement>(`[data-panel-shell="${CSS.escape(id)}"]`);
	const panelDockOffset = (id: string) => {
		const panel = panelShellFor(id);
		const dock = dockElementFor(id);
		if (!panel || !dock) return null;
		const panelRect = panel.getBoundingClientRect();
		const dockRect = dock.getBoundingClientRect();
		return {
			panel,
			x: (dockRect.left + dockRect.width / 2 - panelRect.left - panelRect.width / 2) / canvasStateRef.current.scale,
			y: (dockRect.top + dockRect.height / 2 - panelRect.top - panelRect.height / 2) / canvasStateRef.current.scale
		};
	};

	const minimizePanel = (id: string) => {
		if (!dockedIds.includes(id)) {
			sendSync({ type: 'dock-tag', id, ...(customLabels[id] ? { label: customLabels[id] } : {}) });
			setDockedIds(previous => previous.includes(id) ? previous : [...previous, id]);
		}
		requestAnimationFrame(() => requestAnimationFrame(() => {
			const target = panelDockOffset(id);
			if (!target) {
				setMinimizedIds(previous => previous.includes(id) ? previous : [...previous, id]);
				return;
			}
			const animation = target.panel.animate([
				{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
				{ transform: `translate(${target.x}px, ${target.y}px) scale(0.05)`, opacity: 0 }
			], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
			void animation.finished.then(() => setMinimizedIds(previous => previous.includes(id) ? previous : [...previous, id]));
		}));
	};

	const restorePanel = (id: string) => {
		const target = panelDockOffset(id);
		if (!target) {
			setMinimizedIds(previous => previous.filter(item => item !== id));
			return;
		}
		const animation = target.panel.animate([
			{ transform: `translate(${target.x}px, ${target.y}px) scale(0.05)`, opacity: 0 },
			{ transform: 'translate(0, 0) scale(1)', opacity: 1 }
		], { duration: 340, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
		setMinimizedIds(previous => previous.filter(item => item !== id));
		void animation.finished.catch(() => {});
	};

	// Fly the viewport so the given panel sits in the middle of the screen at a
	// size that's actually usable for its content. The panel itself never moves
	// — the dock is navigation, not relocation; only the viewport changes.
	const jumpToPanel = (id: string) => {
		if (minimizedIds.includes(id)) {
			restorePanel(id);
			return;
		}
		// Going there counts as seeing it
		acknowledgePulse(id);
		const positionTag = positionTags.find(tag => tag.id === id);
		const isFixed = id === 'local' || id === 'remote';
		const remotePeerId = peerIdFromPanelId(id);
		const panel = isFixed || remotePeerId ? null : dynamicPanels.find(p => p.id === id);
		const target = positionTag
			? {
					x: positionTag.x,
					y: positionTag.y,
					width: positionTag.w ?? 0,
					height: positionTag.h ?? 0,
					z: 0
			  }
			: isFixed
				? fixedPanels[id]
				: remotePeerId
					? remotePanelStates[remotePeerId]
					: panel?.state;
		if (!target) return;

		const type: DockEntry['type'] = positionTag ? 'position' : remotePeerId ? 'remote' : isFixed ? id : (panel?.type ?? 'youtube');
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		// How wide the panel should appear on screen, by content type. A video
		// needs real estate to be watchable; an audio player would look absurd
		// blown up to fill the viewport.
		const IDEAL_ON_SCREEN_WIDTH: Record<DockEntry['type'], number> = {
			youtube: 720,
			local: 480,
			remote: 480,
			audio: 360,
			note: 420,
			browser: 760,
			code: 640,
			recorder: 720,
			image: 680,
			position: 0
		};

		// Start from the ideal width, then make sure the whole panel still fits
		// on screen with a margin, and stay inside the app's zoom limits.
		const hasBounds = !!positionTag && !!positionTag.w && !!positionTag.h;
		const fitScale =
			positionTag && !hasBounds
				? canvasStateRef.current.scale
				: Math.min((vw * 0.9) / target.width, (vh * 0.85) / target.height);
		const idealScale = positionTag ? canvasStateRef.current.scale : IDEAL_ON_SCREEN_WIDTH[type] / target.width;
		// Position tags are points of interest rather than sizeable panels:
		// centre the point and zoom closer on every visit.
		const toScale = hasBounds
			? // An area tag knows its own size, so frame it rather than guessing
				Math.max(0.25, Math.min(4, fitScale))
			: positionTag
				? // A point has no size: creep closer on each visit instead
					Math.min(4, Math.max(1.5, canvasStateRef.current.scale * 1.6))
				: Math.max(0.25, Math.min(4, fitScale, idealScale));

		const { x: fromX, y: fromY, scale: fromScale } = canvasStateRef.current;
		const destX = vw / 2 - (target.x + target.width / 2) * toScale;
		const destY = vh / 2 - (target.y + target.height / 2) * toScale;
		const dx = destX - fromX;
		const dy = destY - fromY;
		const dScale = toScale - fromScale;
		// Already framed — nothing to animate
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dScale) < 0.01) return;

		if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);

		const DURATION = 420;
		const startedAt = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - startedAt) / DURATION);
			const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
			setCanvas({
				x: fromX + dx * eased,
				y: fromY + dy * eased,
				scale: fromScale + dScale * eased
			});
			jumpAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
		};
		jumpAnimRef.current = requestAnimationFrame(step);
	};

	// Cancel any in-flight jump and pending timers on unmount
	useEffect(() => {
		const pulseTimers = pulseTimersRef.current;
		const noteTimers = noteSendTimersRef.current;
		const codeTimers = codeSendTimersRef.current;
		return () => {
			if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);
			Object.values(pulseTimers).forEach(clearTimeout);
			Object.values(noteTimers).forEach(clearTimeout);
			Object.values(codeTimers).forEach(clearTimeout);
		};
	}, []);

	// Fallback dock label for a panel with nothing yet to name itself after (no
	// video loaded, no file chosen). Numbered only when more than one of that
	// type exists, so a lone panel reads "YouTube" rather than "YouTube 1".
	const fallbackLabel = (panel: DynamicPanel): string => {
		// A note names itself after its contents where it can — the chord name,
		// or the note's first line — before falling back to a numbered label.
		if (panel.type === 'note' && panel.note) {
			const { kind, text } = panel.note;
			if (kind === 'chord') {
				const named = chordsOf(panel.note).filter(c => c.name.trim());
				if (named.length) {
					const first = named[0].name.trim();
					return named.length > 1 ? `${first} +${named.length - 1}` : first;
				}
			}
			const firstLine = text.split('\n')[0].trim();
			if (kind === 'text' && firstLine) return firstLine.slice(0, 40);
		}
		const base = panel.type === 'youtube' ? 'YouTube' : panel.type === 'note' ? 'Note' : panel.type === 'browser' ? 'Browser' : panel.type === 'code' ? 'Code' : panel.type === 'recorder' ? 'Recorder' : panel.type === 'image' ? 'Image' : 'Audio';
		const sameType = dynamicPanels.filter(p => p.type === panel.type);
		if (sameType.length < 2) return base;
		return `${base} ${sameType.findIndex(p => p.id === panel.id) + 1}`;
	};

	// Label precedence: user-set name → derived from content → typed fallback
	const dockEntries: DockEntry[] = dockedIds.flatMap((id): DockEntry[] => {
		const custom = customLabels[id];
		const pulsing = pulsingIds.includes(id);
		const positionTag = positionTags.find(tag => tag.id === id);
		if (positionTag) {
			return [{ id, type: 'position', label: custom ?? positionTag.label, renamed: !!custom, pulsing }];
		}
		if (id === 'local' || id === 'remote') {
			const auto = id === 'local' ? 'You' : 'Guest';
			return [{ id, type: id, label: custom ?? auto, renamed: !!custom, pulsing }];
		}
		const remotePeerId = peerIdFromPanelId(id);
		if (remotePeerId) {
			const index = remoteStreams.findIndex(remote => remote.peerId === remotePeerId);
			if (index < 0) return [];
			return [{ id, type: 'remote', label: custom ?? `Guest ${index + 1}`, renamed: !!custom, pulsing }];
		}
		const panel = dynamicPanels.find(p => p.id === id);
		if (!panel) return [];
		return [
			{
				id,
				type: panel.type,
				label: custom ?? panelLabels[id] ?? fallbackLabel(panel),
				renamed: !!custom,
				pulsing
			}
		];
	});

	const pingDockEntry = (id: string) => {
		sendSync({ type: 'dock-ping', id });
	};

	const handleParticipantDoubleClick = (entry: DockEntry) => {
		if (entry.type === 'local') {
			const current = canvasStateRef.current;
			sendSync({ type: 'view-suggestion', id: 'local', canvas: { ...current } });
			return;
		}
		pendingViewRequestRef.current = entry.id;
		sendSync({ type: 'view-request', id: entry.id });
	};

	const showAll = () => {
		const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
		if (localStream?.getTracks().length) bounds.push(fixedPanels.local);
		bounds.push(...Object.values(remotePanelStates), ...dynamicPanels.map(panel => panel.state));
		positionTags.forEach(tag => bounds.push({ x: tag.x, y: tag.y, width: tag.w ?? 1, height: tag.h ?? 1 }));
		for (const item of whiteboardRef.current?.getItems() ?? []) {
			if ('kind' in item && item.kind === 'text') {
				const size = item.size * Math.min(window.innerWidth, window.innerHeight);
				bounds.push({ x: item.x * window.innerWidth, y: item.y * window.innerHeight - size, width: Math.max(size, item.text.length * size * 0.55), height: size * 1.3 });
			} else if ('x0' in item) {
				const x0 = item.x0 * window.innerWidth;
				const y0 = item.y0 * window.innerHeight;
				const x1 = item.x1 * window.innerWidth;
				const y1 = item.y1 * window.innerHeight;
				bounds.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(1, Math.abs(x1 - x0)), height: Math.max(1, Math.abs(y1 - y0)) });
			}
		}
		if (!bounds.length) {
			setCanvas({ x: 0, y: 0, scale: 1 });
			return;
		}
		const minX = Math.min(...bounds.map(item => item.x));
		const minY = Math.min(...bounds.map(item => item.y));
		const maxX = Math.max(...bounds.map(item => item.x + item.width));
		const maxY = Math.max(...bounds.map(item => item.y + item.height));
		const width = Math.max(1, maxX - minX);
		const height = Math.max(1, maxY - minY);
		const scale = Math.max(0.25, Math.min(4, (window.innerWidth * 0.9) / width, (window.innerHeight * 0.78) / height));
		setCanvas({ x: window.innerWidth / 2 - (minX + width / 2) * scale, y: window.innerHeight / 2 - (minY + height / 2) * scale, scale });
	};

	// Empty string clears the custom name and reverts to the automatic label.
	// Shared, since these are bookmarks in a canvas both people are looking at.
	const renameDockEntry = (id: string, label: string) => {
		sendSync({ type: 'dock-rename', id, label });
		setCustomLabels(prev => {
			if (!label) {
				if (!(id in prev)) return prev;
				const next = { ...prev };
				delete next[id];
				return next;
			}
			return { ...prev, [id]: label };
		});
	};

	/**
	 * Zoomed far enough out that panel headers are too small to hit.
	 *
	 * At 30% a header bar is about 8px tall on screen — visible, but not
	 * something you can reliably click, which leaves anything untagged
	 * effectively unreachable until you zoom back in and hunt for it.
	 */
	const zoomedOut = canvas.scale < 0.45;

	/**
	 * A tag handle that stays the same size on screen however far out you are.
	 *
	 * Counter-scaling by the canvas scale is what keeps it legible: everything
	 * inside the canvas shrinks with the zoom, so a handle that didn't fight
	 * back would be exactly as unclickable as the header it stands in for.
	 * Only shown for things that aren't tagged yet — once it's in the dock, the
	 * chip is the way back to it.
	 */
	const zoomTagHandle = (id: string, label: string) =>
		zoomedOut && !dockedIds.includes(id) ? (
			<button
				onClick={e => {
					e.stopPropagation();
					toggleDock(id);
				}}
				title={`Tag ${label}`}
				aria-label={`Tag ${label}`}
				className="absolute top-0 left-0 z-30 flex items-center gap-1 rounded-md bg-violet-600/95 hover:bg-violet-500 text-white text-[11px] font-medium px-1.5 py-1 shadow-lg pointer-events-auto"
				style={{
					transform: `scale(${1 / canvas.scale})`,
					transformOrigin: 'top left'
				}}>
				<svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
					<path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
				</svg>
				<span className="max-w-[7rem] truncate">{label}</span>
			</button>
		) : null;

	// Compute spatial volume (0–1) for an audio panel.
	//
	// Two factors multiplied together:
	//   sizeFactor    — how large the panel appears on screen (zoom-driven).
	//                   Full volume when apparent height ≥ 20% of viewport height.
	//   proximityFactor — how close the panel centre is to the viewport centre
	//                   (pan-driven). Falls to 0 as the panel drifts to ~1.5×
	//                   the viewport radius away from centre.
	const spatialVolumeForPanel = (state: PanelState): number => {
		const { x: tx, y: ty, scale } = canvas;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		// Panel bounds in screen-space pixels
		const left = state.x * scale + tx;
		const right = (state.x + state.width) * scale + tx;
		const top = state.y * scale + ty;
		const bottom = (state.y + state.height) * scale + ty;

		// Off-screen → silence
		const ix = Math.min(right, vw) - Math.max(left, 0);
		const iy = Math.min(bottom, vh) - Math.max(top, 0);
		if (ix <= 0 || iy <= 0) return 0;

		// Size factor: apparent height relative to 20% of viewport (zoom-driven)
		const apparentH = state.height * scale;
		const sizeFactor = Math.min(1, apparentH / (vh * 0.2));

		// Proximity factor: distance of panel centre from viewport centre (pan-driven)
		const cx = (left + right) / 2;
		const cy = (top + bottom) / 2;
		const ndx = (cx - vw / 2) / (vw / 2); // ±1 at each edge
		const ndy = (cy - vh / 2) / (vh / 2);
		const dist = Math.sqrt(ndx * ndx + ndy * ndy);
		// Full at centre (dist=0), falls to 0 at ~1.5× viewport radius
		const proximityFactor = Math.max(0, 1 - dist / 1.5);

		return Math.min(1, sizeFactor * proximityFactor);
	};

	// Spawn a new dynamic panel at the given screen position (screen coords → world coords).
	// Pass fromRemote=true when applying a remote-initiated spawn (skips sync to avoid loops).
	const spawnPanel = (
		type: 'youtube' | 'audio' | 'browser' | 'note' | 'code' | 'recorder' | 'image',
		screenX: number,
		screenY: number,
		extra?: { initialVideoId?: string; initialFile?: File; initialUrl?: string; note?: NoteContent; code?: CodeContent; dimensions?: { width: number; height: number } },
		remoteId?: string
	) => {
		const { x: tx, y: ty, scale } = canvasStateRef.current;
		const imageRatio = extra?.dimensions ? extra.dimensions.width / extra.dimensions.height : 4 / 3;
		const imageWidth = imageRatio >= 1 ? 520 : Math.max(240, 420 * imageRatio);
		const imageHeight = (imageRatio >= 1 ? Math.max(180, 520 / imageRatio) : 420) + 32;
		const w = type === 'image' ? imageWidth : type === 'browser' ? 560 : type === 'recorder' ? 600 : type === 'code' ? 520 : type === 'youtube' ? 320 : type === 'note' ? 300 : 300;
		const h = type === 'image' ? imageHeight : type === 'browser' ? 420 : type === 'recorder' ? 480 : type === 'code' ? 380 : type === 'youtube' ? 260 : type === 'note' ? 300 : 360;
		const worldX = (screenX - tx) / scale - w / 2;
		const worldY = (screenY - ty) / scale - h / 2;
		const nextZ = ++topZRef.current;
		const id = remoteId ?? crypto.randomUUID();
		const state: PanelState = { x: worldX, y: worldY, width: w, height: h, z: nextZ };
		const panelExtra: Partial<DynamicPanel> = {
			initialVideoId: extra?.initialVideoId,
			initialFile: extra?.initialFile,
			initialUrl: extra?.initialUrl,
			note: extra?.note,
			code: extra?.code
		};
		setDynamicPanels(prev => [...prev, { id, type, state, ...panelExtra }]);
		const imageFile = type === 'image' ? extra?.initialFile : undefined;
		if (imageFile) setPanelLabels(prev => ({ ...prev, [id]: imageFile.name }));
		setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));

		// Only sync outward for locally-initiated spawns
		if (!remoteId) {
			if (type === 'youtube') {
				sendSync({ type: 'spawn-youtube', id, videoId: extra?.initialVideoId, state: normalisePanel(state) });
			} else if (type === 'browser') {
				sendSync({ type: 'spawn-browser', id, url: extra?.initialUrl, state: normalisePanel(state) });
			} else if (type === 'audio') {
				// The panel goes over first and the bytes follow, so the other
				// side sees it appear and fill rather than waiting on silence.
				sendSync({ type: 'spawn-audio', id, state: normalisePanel(state) });
				if (extra?.initialFile) sendFileTo(id, extra.initialFile);
			} else if (type === 'note') {
				sendSync({ type: 'spawn-note', id, state: normalisePanel(state), note: extra?.note ?? defaultNoteContent() });
			} else if (type === 'code') {
				sendSync({ type: 'spawn-code', id, state: normalisePanel(state), code: extra?.code ?? { text: '', language: 'text' } });
			} else if (type === 'recorder') {
				sendSync({ type: 'spawn-recorder', id, state: normalisePanel(state) });
			} else if (type === 'image') {
				sendSync({ type: 'spawn-image', id, state: normalisePanel(state) });
				if (extra?.initialFile) sendFileTo(id, extra.initialFile);
			}
		}
	};

	const addImage = async (file: File, screenX: number, screenY: number) => {
		try {
			const prepared = await prepareImage(file);
			spawnPanel('image', screenX, screenY, {
				initialFile: prepared.file,
				dimensions: { width: prepared.width, height: prepared.height }
			});
			setMediaError(null);
		} catch (error) {
			setMediaError(error instanceof Error ? error.message : 'The image could not be added.');
		}
	};

	// Note edits are sent whole but debounced, so typing doesn't flood the
	// channel. The local state updates immediately either way.
	const noteSendTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	const updateNote = (id: string, note: NoteContent) => {
		setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, note } : p)));
		const timers = noteSendTimersRef.current;
		if (timers[id]) clearTimeout(timers[id]);
		timers[id] = setTimeout(() => {
			sendSync({ type: 'note-update', id, note });
			delete timers[id];
		}, 250);
	};

	const codeSendTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	const updateCode = (id: string, code: CodeContent) => {
		setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, code } : p)));
		if (codeSendTimersRef.current[id]) clearTimeout(codeSendTimersRef.current[id]);
		codeSendTimersRef.current[id] = setTimeout(() => {
			sendSync({ type: 'code-update', id, code });
			delete codeSendTimersRef.current[id];
		}, 250);
	};
	const updatePanelPlayback = useCallback((id: string, playback: NonNullable<DynamicPanel['playback']>) => {
		setDynamicPanels(prev => prev.map(panel => panel.id === id ? { ...panel, playback } : panel));
	}, []);
	const updateDynamicPanel = useCallback((id: string, patch: Partial<DynamicPanel>) => {
		setDynamicPanels(prev => prev.map(panel => panel.id === id ? { ...panel, ...patch } : panel));
	}, []);
	const toggleMicrophone = useCallback(() => {
		const tracks = localStream?.getAudioTracks() ?? [];
		if (!tracks.length) return;
		const enabled = !tracks.some(track => track.enabled);
		tracks.forEach(track => { track.enabled = enabled; });
		setMicrophoneEnabled(enabled);
	}, [localStream]);
	const toggleCamera = useCallback(async () => {
		const tracks = localStream?.getVideoTracks() ?? [];
		if (tracks.length) {
			await replaceVideoTrack(null);
			tracks.forEach(track => {
				track.stop();
				localStream?.removeTrack(track);
			});
			setCameraEnabled(false);
			return;
		}
		try {
			const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
			const track = cameraStream.getVideoTracks()[0];
			if (!track || !localStream) return;
			localStream.addTrack(track);
			await replaceVideoTrack(track);
			setCameraEnabled(true);
			setMediaError(null);
		} catch {
			setMediaError('Camera could not be restarted. Check browser permission and try again.');
		}
	}, [localStream, replaceVideoTrack]);

	useEffect(() => {
		let stream: MediaStream | undefined;

		const acquireMedia = async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia) {
					throw new DOMException('Media devices are unavailable', 'NotFoundError');
				}
				stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
				setLocalStream(stream);
			} catch (err) {
				const mediaFailure = err as Error;
				// An empty stream marks media setup as complete and lets usePeer
				// join in receive-only/data-only mode.
				stream = new MediaStream();
				setLocalStream(stream);

				if (mediaFailure.name === 'NotAllowedError' || mediaFailure.name === 'PermissionDeniedError') {
					setMediaError('Camera and microphone access was denied. You joined without sharing media.');
				} else {
					setMediaError('Camera and microphone are unavailable. You joined without sharing media.');
				}
			}
		};

		void acquireMedia();

		return () => {
			stream?.getTracks().forEach(t => t.stop());
		};
	}, []);

	// ── Paste onto the canvas ────────────────────────────────────────────────
	// Whatever is on the clipboard lands where the pointer is, as the nearest
	// sensible thing: an image becomes a compressed panel, a YouTube link becomes
	// a player, any other link becomes a browser panel, and plain text becomes
	// canvas text.
	const pointerRef = useRef({ x: 0, y: 0 });
	useEffect(() => {
		const onPointer = (e: PointerEvent) => {
			pointerRef.current = { x: e.clientX, y: e.clientY };
		};
		window.addEventListener('pointermove', onPointer);
		return () => window.removeEventListener('pointermove', onPointer);
	}, []);

	useEffect(() => {
		const { x, y } = pointerRef.current;
		if (x || y) broadcastCursor(x, y);
	}, [broadcastCursor, canvas]);

	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			if (e.defaultPrevented) return;
			// Never hijack a paste aimed at a note, the rename box or a URL bar.
			// The target is only an Element when something is focused — a paste
			// with focus on the document itself reports the window.
			const el = e.target instanceof Element ? e.target : null;
			if (el?.closest('input, textarea, [contenteditable="true"]')) return;

			// Drop it where the pointer is; fall back to the middle of the screen
			// when pasted by keyboard without the mouse having moved.
			const { x, y } = pointerRef.current;
			const px = x || window.innerWidth / 2;
			const py = y || window.innerHeight / 2;
			const image = Array.from(e.clipboardData?.items ?? [])
				.find(item => item.kind === 'file' && item.type.startsWith('image/'))
				?.getAsFile();
			if (image) {
				e.preventDefault();
				void addImage(image, px, py);
				return;
			}

			const raw = e.clipboardData?.getData('text')?.trim();
			if (!raw) return;
			e.preventDefault();

			const videoId = parseYouTubeVideoId(raw);
			if (videoId) {
				spawnPanel('youtube', px, py, { initialVideoId: videoId });
				return;
			}

			if (/^https?:\/\//i.test(raw)) {
				spawnPanel('browser', px, py, { initialUrl: raw });
				return;
			}

			const code = codeFromText(raw);
			if (code) {
				spawnPanel('code', px, py, { code });
				return;
			}

			// Anything else is words: place it as canvas text
			const item: WhiteboardText = {
				kind: 'text',
				id: crypto.randomUUID(),
				x: (px - canvasStateRef.current.x) / canvasStateRef.current.scale / window.innerWidth,
				y: (py - canvasStateRef.current.y) / canvasStateRef.current.scale / window.innerHeight,
				text: raw.split('\n')[0].slice(0, 200),
				color: activeColor,
				size: wbTextSize / Math.min(window.innerWidth, window.innerHeight),
				font: wbFont
			};
			whiteboardRef.current?.drawText(item);
			handleWbText(item);
		};
		window.addEventListener('paste', onPaste);
		return () => window.removeEventListener('paste', onPaste);
	});

	// Wheel → zoom toward cursor (non-passive so we can preventDefault)
	useEffect(() => {
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
			setCanvas(prev => {
				const s = Math.min(4, prev.scale * factor);
				return {
					x: e.clientX - ((e.clientX - prev.x) / prev.scale) * s,
					y: e.clientY - ((e.clientY - prev.y) / prev.scale) * s,
					scale: s
				};
			});
		};
		window.addEventListener('wheel', onWheel, { passive: false });
		return () => window.removeEventListener('wheel', onWheel);
	}, []);

	// Pinch-to-zoom + two-finger pan (touch devices)
	// Attached as native listeners (passive: false on move so we can preventDefault)
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length < 2) return;
			const t0 = e.touches[0];
			const t1 = e.touches[1];
			gestureRef.current = {
				lastDist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
				lastMid: {
					x: (t0.clientX + t1.clientX) / 2,
					y: (t0.clientY + t1.clientY) / 2
				}
			};
		};

		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length < 2 || !gestureRef.current) return;
			e.preventDefault();
			const t0 = e.touches[0];
			const t1 = e.touches[1];
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const mid = {
				x: (t0.clientX + t1.clientX) / 2,
				y: (t0.clientY + t1.clientY) / 2
			};
			const { lastDist, lastMid } = gestureRef.current;
			const factor = lastDist > 0 ? dist / lastDist : 1;
			setCanvas(prev => {
				const s = Math.min(4, Math.max(0.25, prev.scale * factor));
				// Zoom toward the midpoint between the two fingers, then pan
				const zoomedX = mid.x - ((mid.x - prev.x) / prev.scale) * s;
				const zoomedY = mid.y - ((mid.y - prev.y) / prev.scale) * s;
				return {
					x: zoomedX + (mid.x - lastMid.x),
					y: zoomedY + (mid.y - lastMid.y),
					scale: s
				};
			});
			gestureRef.current = { lastDist: dist, lastMid: mid };
		};

		const onTouchEnd = (e: TouchEvent) => {
			if (e.touches.length < 2) gestureRef.current = null;
		};

		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchmove', onTouchMove, { passive: false });
		el.addEventListener('touchend', onTouchEnd, { passive: true });
		return () => {
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchmove', onTouchMove);
			el.removeEventListener('touchend', onTouchEnd);
		};
	}, []);

	// Space key → pan mode (shows grab-cursor overlay that intercepts all clicks)
	useEffect(() => {
		const onDown = (e: KeyboardEvent) => {
			if (e.code === 'Space' && !(e.target as HTMLElement)?.closest('input, textarea')) {
				e.preventDefault();
				setIsPanMode(true);
			}
		};
		const onUp = (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				setIsPanMode(false);
				setIsGrabbing(false);
				isPanningRef.current = false;
			}
		};
		window.addEventListener('keydown', onDown);
		window.addEventListener('keyup', onUp);
		return () => {
			window.removeEventListener('keydown', onDown);
			window.removeEventListener('keyup', onUp);
		};
	}, []);

	// ── Pan helpers (shared by space-overlay and middle-click) ───────────
	const startPan = (clientX: number, clientY: number) => {
		isPanningRef.current = true;
		panStartRef.current = {
			mx: clientX,
			my: clientY,
			cx: canvasStateRef.current.x,
			cy: canvasStateRef.current.y
		};
		setIsGrabbing(true);
	};

	const movePan = (clientX: number, clientY: number) => {
		if (!isPanningRef.current) return;
		const dx = clientX - panStartRef.current.mx;
		const dy = clientY - panStartRef.current.my;
		setCanvas(prev => ({
			...prev,
			x: panStartRef.current.cx + dx,
			y: panStartRef.current.cy + dy
		}));
	};

	const endPan = () => {
		isPanningRef.current = false;
		setIsGrabbing(false);
	};

	const cancelLongPress = () => {
		if (!longPressRef.current) return;
		clearTimeout(longPressRef.current.timer);
		longPressRef.current = null;
	};

	// Middle or right-click drag on the background pans without space held
	const handleOuterMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
		if ((e.button === 1 || e.button === 2) && e.target instanceof HTMLCanvasElement) {
			e.preventDefault();
			startPan(e.clientX, e.clientY);
			return;
		}
		if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement) || isPanMode) return;

		cancelLongPress();
		const screenX = e.clientX;
		const screenY = e.clientY;
		const timer = setTimeout(() => {
			const { x: tx, y: ty, scale } = canvasStateRef.current;
			const tag: PositionTag = {
				id: crypto.randomUUID(),
				x: (screenX - tx) / scale,
				y: (screenY - ty) / scale,
				label: `Position ${positionTagsRef.current.length + 1}`
			};
			longPressRef.current = null;
			setPositionTags(prev => [...prev, tag]);
			setDockedIds(prev => [...prev, tag.id]);
			sendSync({
				type: 'position-tag',
				id: tag.id,
				x: tag.x,
				y: tag.y,
				label: tag.label
			});
		}, 2000);
		longPressRef.current = { timer, x: screenX, y: screenY };
	};
	const handleOuterMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
		const pending = longPressRef.current;
		if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 6) cancelLongPress();
		movePan(e.clientX, e.clientY);
	};
	const handleOuterMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
		cancelLongPress();
		if (e.button === 1 || e.button === 2) endPan();
	};

	useEffect(
		() => () => {
			if (longPressRef.current) clearTimeout(longPressRef.current.timer);
		},
		[]
	);

	// ── Dot-grid background ───────────────────────────────────────────────
	const GRID = 32;
	const scaledGrid = Math.max(8, GRID * canvas.scale);
	const bgX = ((canvas.x % scaledGrid) + scaledGrid) % scaledGrid;
	const bgY = ((canvas.y % scaledGrid) + scaledGrid) % scaledGrid;

	const statusLabel: Record<string, string> = {
		idle: 'Setting up…',
		connecting: 'Connecting…',
		waiting: 'Waiting for guest…',
		connected: `Connected · ${participantCount}/4`,
		error: ''
	};
	const recorderStatusList = Object.values(recorderStatuses);
	const anyRecorderActive = recorderStatusList.some(item => item.recording);
	const recorderErrors = [...new Set(recorderStatusList.flatMap(item => item.errors))];

	return (
		<div
			className="relative w-screen h-screen overflow-hidden select-none"
			ref={containerRef}
			style={{
				backgroundColor: '#111',
				backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.18) 1px, transparent 1px)',
				backgroundSize: `${scaledGrid}px ${scaledGrid}px`,
				backgroundPosition: `${bgX}px ${bgY}px`,
				...(bgDragOver && {
					outline: '2px solid rgba(139,92,246,0.6)',
					outlineOffset: '-2px'
				})
			}}
			onMouseDown={handleOuterMouseDown}
			onMouseMove={handleOuterMouseMove}
			onMouseUp={handleOuterMouseUp}
			onMouseLeave={handleOuterMouseUp}
			onPointerMove={event => broadcastCursor(event.clientX, event.clientY)}
			onPointerLeave={() => sendSync({ type: 'cursor-leave' })}
			onContextMenu={e => {
				if (e.target instanceof HTMLCanvasElement) e.preventDefault();
			}}
			onDragOver={e => {
				const hasFile = e.dataTransfer.types.includes('Files');
				const hasUrl = e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('text/plain');
				if (hasFile || hasUrl) {
					e.preventDefault();
					setBgDragOver(true);
				}
			}}
			onDragLeave={e => {
				// Only clear if leaving the root element entirely
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setBgDragOver(false);
			}}
			onDrop={e => {
				e.preventDefault();
				setBgDragOver(false);
				const image = Array.from(e.dataTransfer.files).find(file => file.type.startsWith('image/'));
				if (image) {
					void addImage(image, e.clientX, e.clientY);
					return;
				}
				// Audio file
				const file = Array.from(e.dataTransfer.files).find(f => f.type.match(/audio\//));
				if (file) {
					spawnPanel('audio', e.clientX, e.clientY, { initialFile: file });
					return;
				}
				// YouTube URL (dragged link from browser)
				const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
				if (text) {
					const videoId = parseYouTubeVideoId(text);
					if (videoId)
						spawnPanel('youtube', e.clientX, e.clientY, {
							initialVideoId: videoId
						});
				}
			}}>
			<input
				ref={imageInputRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0];
					if (file) void addImage(file, window.innerWidth / 2, window.innerHeight / 2);
					event.target.value = '';
				}}
			/>
			<input
				ref={roomBundleInputRef}
				type="file"
				accept=".json,application/json"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0];
					if (file) void importRoomBundle(file);
					event.target.value = '';
				}}
			/>
			{/* Top bar — fixed overlay, not part of draggable canvas */}
			<div
				data-canvas-chrome
				className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-2 sm:px-4 bg-zinc-950/90 backdrop-blur-sm border-b border-zinc-800/60"
				style={{
					paddingTop: 'env(safe-area-inset-top)',
					paddingBottom: '0.5rem'
				}}>
				<div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
					<span className="text-white font-bold text-sm sm:text-base tracking-tight whitespace-nowrap">watchtogether</span>
					<span
						className={`text-xs px-2 sm:px-2.5 py-0.5 rounded-full font-medium shrink-0 ${
							status === 'connected' ? 'bg-emerald-500/20 text-emerald-400' : status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-zinc-700 text-zinc-400'
						}`}>
						{error ? (
							'Error'
						) : status === 'waiting' ? (
							<span>
								<span className="hidden sm:inline">Waiting for guest…</span>
								<span className="sm:hidden">Waiting…</span>
							</span>
						) : (
							statusLabel[status]
						)}
					</span>
				</div>

				<div className="ml-auto flex w-fit shrink-0 items-center justify-end gap-1 sm:gap-2">
				{/* Zoom controls */}
				<div className="flex items-center gap-0.5">
					<button
						onClick={() => setCanvas(c => ({ ...c, scale: c.scale / 1.25 }))}
						className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-base leading-none"
						title="Zoom out">
						−
					</button>
					<button
						onClick={() => setCanvas({ x: 0, y: 0, scale: 1 })}
						className="px-1 sm:px-1.5 tabular-nums text-xs text-zinc-400 hover:text-white transition-colors min-w-[2.75rem] sm:min-w-[3.25rem] text-center rounded hover:bg-zinc-700 py-1"
						title="Reset view (100%)">
						{Math.round(canvas.scale * 100)}%
					</button>
					<button
						onClick={() => setCanvas(c => ({ ...c, scale: Math.min(4, c.scale * 1.25) }))}
						className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-base leading-none"
						title="Zoom in">
						+
					</button>
					<button
						onClick={() => setLaserEnabled(enabled => !enabled)}
						className={`ml-1 flex h-7 items-center gap-1 rounded border px-1.5 text-xs transition-colors ${laserEnabled ? 'border-rose-400 bg-rose-500/20 text-rose-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-700 hover:text-white'}`}
						title={laserEnabled ? 'Turn off laser pointer (L)' : 'Turn on laser pointer (L)'}
						aria-pressed={laserEnabled}>
						<span className={`h-2 w-2 rounded-full ${laserEnabled ? 'animate-pulse bg-rose-400 shadow-[0_0_8px_#fb7185]' : 'bg-zinc-500'}`} />
						<span className="hidden lg:inline">Laser</span>
					</button>
				</div>

				{/* Add media buttons (desktop rail) */}
				<div className="fixed right-3 z-[999] hidden max-h-[calc(100vh-5rem)] w-32 shrink-0 flex-col items-stretch gap-1.5 overflow-y-auto lg:flex" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.75rem)' }}>
					<button
						onClick={() => imageInputRef.current?.click()}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add an image">
						<svg className="h-3.5 w-3.5 shrink-0 text-fuchsia-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 3.5 3.5 2-2L20 19" />
						</svg>
						<span>Image</span>
					</button>
					<button
						onClick={() => spawnPanel('note', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a sticky note">
						<svg className="w-3.5 h-3.5 text-amber-300 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M5 3h14a2 2 0 012 2v9l-7 7H5a2 2 0 01-2-2V5a2 2 0 012-2zm9 17.5V15a1 1 0 011-1h5.5L14 20.5z" />
						</svg>
						<span>Note</span>
					</button>
					<button
						onClick={() => spawnPanel('code', window.innerWidth / 2, window.innerHeight / 2, { code: { text: '', language: 'text' } })}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a code editor">
						<span className="font-mono text-emerald-400">&lt;/&gt;</span>
						<span>Code</span>
					</button>
					<button
						onClick={() => spawnPanel('recorder', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a screen recorder">
						<span className="h-3.5 w-3.5 rounded-full border-2 border-red-300 bg-red-500" />
						<span>Record</span>
					</button>
					<button
						onClick={() => spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a YouTube player">
						<svg className="w-3.5 h-3.5 text-red-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
						</svg>
						<span>YouTube</span>
					</button>
					<button
						onClick={() => spawnPanel('audio', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add an audio player">
						<svg className="w-3.5 h-3.5 text-violet-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
						</svg>
						<span>Audio</span>
					</button>
					<button
						onClick={() => spawnPanel('browser', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex w-full items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a mini browser">
						<svg className="w-3.5 h-3.5 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<path d="M3 9h18M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
						</svg>
						<span>Browser</span>
					</button>
				</div>

				{/* Add media buttons (mobile/tablet hamburger) */}
				<div ref={widgetMenuRef} className="relative shrink-0 lg:hidden">
					<button
						onClick={() => setWidgetMenuOpen(open => !open)}
						className="w-8 h-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 rounded-lg transition-colors"
						title="Add widget"
						aria-label="Add widget"
						aria-haspopup="menu"
						aria-expanded={widgetMenuOpen}>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
						</svg>
					</button>
					{widgetMenuOpen && (
						<div className="absolute right-0 mt-2 w-40 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-xl p-1.5 shadow-xl z-50">
							<button
								onClick={() => {
									imageInputRef.current?.click();
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Image
							</button>
							<button
								onClick={() => {
									spawnPanel('note', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Note
							</button>
							<button
								onClick={() => {
									spawnPanel('code', window.innerWidth / 2, window.innerHeight / 2, { code: { text: '', language: 'text' } });
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Code
							</button>
							<button
								onClick={() => {
									spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								YouTube
							</button>
							<button
								onClick={() => {
									spawnPanel('audio', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Audio
							</button>
							<button
								onClick={() => {
									spawnPanel('browser', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Browser
							</button>
						</div>
					)}
				</div>

				<button
					onClick={presentingId ? stopPresenting : startPresenting}
					disabled={!presentingId && participantCount < 2}
					className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${presentingId ? 'border-violet-400 bg-violet-600 text-white hover:bg-violet-500' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
					title={presentingId ? 'Stop presenting your viewport' : participantCount < 2 ? 'Invite someone before presenting' : 'Invite everyone to follow your viewport'}>
					<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
						<path strokeLinecap="round" strokeLinejoin="round" d="M8 5h8a3 3 0 013 3v5a3 3 0 01-3 3h-3l-3.5 3v-3H8a3 3 0 01-3-3V8a3 3 0 013-3z" />
						<path strokeLinecap="round" d="M9 9.5h6M9 12.5h4" />
					</svg>
					<span className="hidden lg:inline">{presentingId ? 'Stop presenting' : 'Present'}</span>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					<button
						onClick={exportRoomBundle}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
						title="Export room bundle"
						aria-label="Export room bundle">
						<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4" /></svg>
					</button>
					<button
						onClick={() => roomBundleInputRef.current?.click()}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
						title="Import room bundle"
						aria-label="Import room bundle">
						<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M5 9v10a2 2 0 002 2h10a2 2 0 002-2V9" /></svg>
					</button>
				</div>

				{/* Anyone in the room can summon, not just whoever opened it — a
				    room holds four, so a guest may well be the one who wants to
				    pull in the fourth. */}
				<SummonButton roomCode={roomCode} />
				</div>
			</div>

			{/* Nobody here yet — the moment you'd actually want to invite
			    someone, rather than hoping they spot the button. `waiting` means
			    the room is live and empty; it clears itself the instant anyone
			    joins.

			    Sits above the dock rather than under the top bar: the tool
			    island occupies that slot at the same offset, and at 375px it
			    covered this card completely. */}
			{status === 'waiting' && !summonPromptDismissed && (
				<div
					className="absolute left-1/2 -translate-x-1/2 z-50 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-xl pl-3 sm:pl-4 pr-2 py-2.5 shadow-xl max-w-[calc(100vw-2rem)]"
					style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom) + 4.75rem)' }}>
					{/* Stacks on a phone: side by side, the sentence squeezes to
					    four words a line and the card stops being readable. */}
					<p className="text-xs sm:text-sm text-zinc-300 whitespace-nowrap">
						Nobody here yet — summon a friend?
					</p>
					<div className="flex items-center gap-2 self-end sm:self-auto">
						<SummonButton roomCode={roomCode} variant="prompt" />
						<button
							onClick={() => setSummonPromptDismissed(true)}
							className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
							title="Dismiss"
							aria-label="Dismiss">
							<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>
				</div>
			)}

			{bundleNotice && (
				<div role={bundleNotice.kind === 'error' ? 'alert' : 'status'} className={`fixed bottom-24 left-1/2 z-[1002] w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl border px-3 py-2 text-center text-xs shadow-xl backdrop-blur ${bundleNotice.kind === 'error' ? 'border-red-700 bg-red-950/95 text-red-200' : 'border-emerald-700 bg-emerald-950/95 text-emerald-200'}`}>
					{bundleNotice.message}
				</div>
			)}

			{viewSuggestion && (
				<div className="fixed left-3 top-16 z-[1000] flex items-center gap-2 rounded-xl border border-violet-500/60 bg-zinc-900/95 p-2 shadow-xl backdrop-blur">
					<button
						onClick={() => {
							setCanvas({ ...viewSuggestion.canvas });
							setViewSuggestion(null);
						}}
						className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500">
						A participant suggested their view — switch
					</button>
					<button onClick={() => setViewSuggestion(null)} className="px-1 text-zinc-400 hover:text-white" title="Dismiss" aria-label="Dismiss view suggestion">×</button>
				</div>
			)}
			{wbTool === 'connector' && (
				<div className="pointer-events-none fixed left-1/2 top-28 z-[999] -translate-x-1/2 rounded-full border border-violet-500/60 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-violet-100 shadow-lg">
					{connectorStartId ? 'Select another panel to connect · select the first again to cancel' : 'Select the first panel to connect'}
				</div>
			)}

			{presentationInvite && (
				<div role="dialog" aria-label="Presentation invitation" className="fixed left-1/2 top-16 z-[1002] w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl border border-violet-500/60 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur">
					<p className="text-sm font-semibold text-white">A participant wants to present</p>
					<p className="mt-1 text-xs leading-relaxed text-zinc-400">Accept to follow their canvas as they pan and zoom. You can stop following at any time.</p>
					<div className="mt-3 flex justify-end gap-2">
						<button onClick={() => setPresentationInvite(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white">Decline</button>
						<button onClick={acceptPresentation} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500">Follow presenter</button>
					</div>
				</div>
			)}

			{following && (
				<div className="fixed left-3 top-16 z-[1001] flex items-center gap-2 rounded-xl border border-violet-500/60 bg-zinc-900/95 px-3 py-2 shadow-xl backdrop-blur">
					<span className="flex items-center gap-2 text-xs font-semibold text-violet-200"><span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />Following presenter</span>
					<button onClick={stopFollowing} className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700">Stop following</button>
				</div>
			)}

			{presentingId && (
				<div className="fixed left-3 top-16 z-[1001] flex items-center gap-2 rounded-xl border border-violet-500/60 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
					<span className="font-semibold text-violet-200">Presenting your view</span>
					<span className="text-zinc-500">{presentationFollowers.length} following</span>
					<button onClick={stopPresenting} className="rounded-lg bg-zinc-800 px-2.5 py-1 font-medium text-white hover:bg-zinc-700">Stop</button>
				</div>
			)}

			{/* Error banner — sits below the top bar (height is variable due to safe-area) */}
			{error && (
				<div
					className="absolute left-4 right-4 z-50 bg-red-950/60 border border-red-700 rounded-xl px-4 py-2.5 text-red-300 text-sm"
					style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					{' '}
					{error}
				</div>
			)}
			{mediaError && !error && (
				<div
					className="absolute left-4 right-4 z-50 bg-amber-950/60 border border-amber-700 rounded-xl px-4 py-2.5 text-amber-200 text-sm"
					style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					{mediaError}
				</div>
			)}
			{(anyRecorderActive || recorderErrors.length > 0) && (
				<div className="absolute right-3 z-[1001] flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 px-2.5 py-2 shadow-xl backdrop-blur" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					{anyRecorderActive && <span className="flex items-center gap-1.5 text-xs font-semibold text-red-300"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />Recording</span>}
					{recorderErrors.length > 0 && (
						<div className="group/recording-info relative">
							<span tabIndex={0} aria-label="Recording warnings" className="flex h-5 w-5 cursor-help items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white">i</span>
							<div role="tooltip" className="pointer-events-none absolute right-0 top-full mt-2 hidden w-72 rounded-xl border border-red-800 bg-red-950/95 p-3 text-xs text-red-200 shadow-2xl group-hover/recording-info:block group-focus-within/recording-info:block">
								{recorderErrors.map(message => <p key={message} className="not-last:mb-2">{message}</p>)}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Whiteboard canvas — sits below all panels, transparent so grid shows through */}
			<Whiteboard
				ref={whiteboardRef}
				tool={wbTool}
				isPanning={isGrabbing}
				color={activeColor}
				width={wbWidth}
				nib={wbNib}
				font={wbFont}
				textSize={wbTextSize}
				shapeKind={wbShapeKind}
				onStroke={handleWbStroke}
				onShape={handleWbShape}
				onText={handleWbText}
				onTextEdit={handleWbTextEdit}
				onTextMove={handleWbTextMove}
				onRegion={handleWbRegion}
				canvasTransform={canvas}
			/>

			{/* Whiteboard toolbar */}
			<WhiteboardToolbar
				tool={wbTool}
				color={activeColor}
				width={wbWidth}
				nib={wbNib}
				font={wbFont}
				textSize={wbTextSize}
				shapeKind={wbShapeKind}
				onFontChange={setWbFont}
				onTextSizeChange={setWbTextSize}
				onShapeKindChange={setWbShapeKind}
				onToolChange={setWbTool}
				onColorChange={setActiveColor}
				onWidthChange={setWbWidth}
				onNibChange={setWbNib}
				onClear={handleWbClear}
			/>

			{/* Space-key pan overlay — sits above whiteboard, below panels, grabs all pointer events */}
			{isPanMode && (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						zIndex: 998,
						cursor: isGrabbing ? 'grabbing' : 'grab'
					}}
					onMouseDown={e => {
						e.preventDefault();
						startPan(e.clientX, e.clientY);
					}}
					onMouseMove={e => movePan(e.clientX, e.clientY)}
					onMouseUp={endPan}
					onMouseLeave={endPan}
				/>
			)}

			{/* Infinite canvas — all panels live here and transform together */}
			<div
				style={{
					position: 'absolute',
					inset: 0,
					transform: `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.scale})`,
					transformOrigin: '0 0',
					// The wrapper covers the viewport but is visually empty outside
					// its children. Let those empty areas reach the whiteboard.
					pointerEvents: 'none'
				}}>
				<svg className="absolute inset-0 z-[4] overflow-visible" width="100%" height="100%" aria-hidden="true">
					{connectors.map(connector => {
						const from = dynamicPanels.find(panel => panel.id === connector.fromPanelId)?.state;
						const to = dynamicPanels.find(panel => panel.id === connector.toPanelId)?.state;
						if (!from || !to) return null;
						const start = panelAnchor(from, to);
						const end = panelAnchor(to, from);
						return <g key={connector.id}>
							<line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#18181b" strokeWidth={connector.width + 4} strokeLinecap="round" />
							<line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={connector.color} strokeWidth={connector.width} strokeLinecap="round" />
							<circle cx={start.x} cy={start.y} r={Math.max(4, connector.width)} fill={connector.color} stroke="#18181b" strokeWidth="2" />
							<circle cx={end.x} cy={end.y} r={Math.max(4, connector.width)} fill={connector.color} stroke="#18181b" strokeWidth="2" />
						</g>;
					})}
				</svg>
				{wbTool === 'connector' && connectors.map(connector => {
					const from = dynamicPanels.find(panel => panel.id === connector.fromPanelId)?.state;
					const to = dynamicPanels.find(panel => panel.id === connector.toPanelId)?.state;
					if (!from || !to) return null;
					const start = panelAnchor(from, to);
					const end = panelAnchor(to, from);
					return <button key={`remove:${connector.id}`} type="button" onClick={() => removeConnector(connector.id)} aria-label="Remove connector" title="Remove connector" className="absolute z-[997] flex h-6 w-6 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-sm text-zinc-300 shadow hover:border-red-500 hover:text-red-300" style={{ left: (start.x + end.x) / 2, top: (start.y + end.y) / 2, pointerEvents: 'auto', transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}>×</button>;
				})}
				{localLaserPoints.map(point => (
					<span
						key={point.id}
						className="laser-trail-point absolute z-[995] h-3 w-3 rounded-full bg-rose-400 shadow-[0_0_12px_4px_rgba(251,113,133,0.8)]"
						style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}
					/>
				))}
				{Object.entries(remoteCursors).flatMap(([peerId, cursor]) => {
					const colour = cursorColour(peerId);
					const remoteIndex = remoteStreams.findIndex(remote => remote.peerId === peerId);
					const label = customLabels[remotePanelId(peerId)] ?? (remoteIndex >= 0 ? `Guest ${remoteIndex + 1}` : `Participant ${peerId.slice(-4)}`);
					return [
						...cursor.laserPoints.map(point => (
							<span
								key={point.id}
								className="laser-trail-point absolute z-[995] h-3 w-3 rounded-full"
								style={{ left: point.x, top: point.y, backgroundColor: colour, boxShadow: `0 0 12px 4px ${colour}cc`, transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}
							/>
						)),
						<div
							key={`cursor:${peerId}`}
							className="absolute z-[996]"
							style={{ left: cursor.x, top: cursor.y, transform: `scale(${1 / canvas.scale})`, transformOrigin: 'top left' }}>
							<svg className="h-6 w-5 drop-shadow-md" viewBox="0 0 20 24" aria-hidden="true">
								<path d="M2 1.5v18l4.8-4.7 3.2 7.2 3.2-1.5-3.1-7H17z" fill={colour} stroke="#18181b" strokeWidth="1.4" strokeLinejoin="round" />
							</svg>
							<span className="absolute left-4 top-4 max-w-32 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-zinc-950 shadow-lg" style={{ backgroundColor: colour }}>{label}</span>
						</div>
					];
				})}
				{positionTags.map(tag =>
					tag.w && tag.h ? (
						<div
							key={tag.id}
							className="absolute z-[5] rounded-md border-2 border-dashed border-amber-400/70 bg-amber-400/5 pointer-events-none"
							style={{ left: tag.x, top: tag.y, width: tag.w, height: tag.h }}
							title={customLabels[tag.id] ?? tag.label}
						/>
					) : (
					<div
						key={tag.id}
						className="absolute z-[5] -translate-x-1/2 -translate-y-full"
						style={{ left: tag.x, top: tag.y }}
						title={customLabels[tag.id] ?? tag.label}>
						<span className="position-tag-ripple absolute left-1/2 bottom-0 w-5 h-5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-amber-400" />
						<svg className="relative w-6 h-8 drop-shadow-lg" viewBox="0 0 24 32" aria-hidden="true">
							<path d="M12 4v23" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
							<path d="M12 5h8l-2.5 4L20 13h-8z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.75" strokeLinejoin="round" />
							<circle cx="12" cy="28" r="3.25" fill="#fbbf24" />
							<circle cx="12" cy="28" r="1.25" fill="#18181b" />
						</svg>
					</div>
					)
				)}
				{localStream && localStream.getTracks().length > 0 && (
					<DraggablePanel panelId="local" minimized={minimizedIds.includes('local')} onMinimize={() => minimizePanel('local')} minimizeControlHandled state={fixedPanels.local} {...makePanelHandlers('local')} onToggleDock={() => toggleDock('local')} minWidth={200} minHeight={120} scale={canvas.scale} className="z-10">
						{zoomTagHandle('local', 'You')}
						{/* No onToggleDock: participants are permanently docked, so a
						    bookmark toggle here would be a button that does nothing */}
						<VideoPanel stream={localStream} label={customLabels.local ?? 'You'} muted docked={dockedIds.includes('local')} localControls microphoneEnabled={microphoneEnabled} cameraEnabled={cameraEnabled} onToggleMicrophone={toggleMicrophone} onToggleCamera={() => void toggleCamera()} onMinimize={() => minimizePanel('local')} />
					</DraggablePanel>
				)}

				{remoteStreams.map(({ peerId, stream }, index) => {
					const state = remotePanelStates[peerId];
					if (!state) return null;
					const label = `Guest ${index + 1}`;
					const panelId = remotePanelId(peerId);
					return (
						<DraggablePanel
							key={peerId}
							panelId={panelId}
							minimized={minimizedIds.includes(panelId)}
							onMinimize={() => minimizePanel(panelId)}
							minimizeControlHandled
							state={state}
							onLocalUpdate={next => setRemotePanelStates(prev => ({ ...prev, [peerId]: next }))}
							onSyncUpdate={next => sendPanelUpdate(panelId, next)}
							onBringToFront={() => {
								const z = ++topZRef.current;
								const next = { ...state, z };
								setRemotePanelStates(prev => ({ ...prev, [peerId]: next }));
								sendPanelUpdate(panelId, next);
							}}
							onToggleDock={() => toggleDock(panelId)}
							minWidth={200}
							minHeight={120}
							scale={canvas.scale}
							className="z-10">
							{zoomTagHandle(panelId, label)}
							<VideoPanel
								stream={stream}
								label={customLabels[panelId] ?? label}
								docked={dockedIds.includes(panelId)}
								onMinimize={() => minimizePanel(panelId)}
							/>
						</DraggablePanel>
					);
				})}

				{dynamicPanels.map(panel => (
					<DraggablePanel
						key={panel.id}
						panelId={panel.id}
						minimized={minimizedIds.includes(panel.id)}
						onMinimize={() => minimizePanel(panel.id)}
						minimizeControlHandled={panel.type === 'youtube' || panel.type === 'code'}
						state={panel.state}
						excludeFromRecording={panel.type === 'recorder'}
						{...makeDynamicPanelHandlers(panel.id)}
						onToggleDock={() => toggleDock(panel.id)}
						minWidth={panel.type === 'browser' ? 360 : panel.type === 'recorder' ? 420 : panel.type === 'code' ? 380 : panel.type === 'youtube' ? 280 : panel.type === 'image' ? 180 : 260}
						minHeight={panel.type === 'browser' ? 240 : panel.type === 'audio' ? 300 : panel.type === 'image' ? 140 : 60}
						scale={canvas.scale}>
						{zoomTagHandle(panel.id, panelLabels[panel.id] ?? fallbackLabel(panel))}
						{panel.type === 'note' ? (
							<StickyNote
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								note={panel.note ?? defaultNoteContent()}
								onChange={next => updateNote(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'code' ? (
								<CodeWidget
									onMinimize={() => minimizePanel(panel.id)}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								code={panel.code ?? { text: '', language: 'text' }}
								onChange={next => updateCode(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'youtube' ? (
							<YoutubeWidget
								onMinimize={() => minimizePanel(panel.id)}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								initialVideoId={panel.initialVideoId}
								initialPlayback={panel.playback}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onVideoChange={videoId => updateDynamicPanel(panel.id, { initialVideoId: videoId })}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
							/>
						) : panel.type === 'recorder' ? (
							<ScreenRecorderWidget
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								getCanvasElement={() => containerRef.current}
								recordings={panel.recordings}
								initialPlayback={panel.playback}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onRecordingComplete={recording => {
									updateDynamicPanel(panel.id, { recordings: [...(panel.recordings ?? []), recording] });
									sendFileTo(panel.id, recording.file, recording.id);
								}}
								onStatusChange={status => setRecorderStatuses(prev => ({ ...prev, [panel.id]: status }))}
								transferProgress={transferProgress[panel.id]}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'image' ? (
							<ImageWidget
								file={panel.initialFile}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? panel.initialFile?.name ?? fallbackLabel(panel)}
								transferProgress={transferProgress[panel.id]}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'audio' ? (
							<AudioPlayer
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								initialFile={panel.initialFile}
								initialPlayback={panel.playback}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTrackChange={name => setPanelLabels(prev => ({ ...prev, [panel.id]: name }))}
								transferProgress={transferProgress[panel.id]}
								onFileChosen={file => {
									updateDynamicPanel(panel.id, { initialFile: file });
									sendFileTo(panel.id, file);
								}}
							/>
						) : (
							<BrowserWidget
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								initialUrl={panel.initialUrl}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
								onUrlChange={url => updateDynamicPanel(panel.id, { initialUrl: url })}
							/>
						)}
					</DraggablePanel>
				))}
				{wbTool === 'connector' && dynamicPanels.map(panel => (
					<button
						key={`connector-target:${panel.id}`}
						type="button"
						onClick={() => selectConnectorPanel(panel.id)}
						aria-label={`${connectorStartId ? 'Connect to' : 'Start connector from'} ${panelLabels[panel.id] ?? fallbackLabel(panel)}`}
						className={`absolute rounded-xl border-2 transition-colors ${connectorStartId === panel.id ? 'border-violet-300 bg-violet-400/20' : 'border-violet-500/70 bg-violet-500/5 hover:bg-violet-500/20'}`}
						style={{ left: panel.state.x, top: panel.state.y, width: panel.state.width, height: panel.state.height, zIndex: 10000 + panel.state.z, pointerEvents: 'auto' }}
					/>
				))}
			</div>

			{/* Dock — fixed overlay above the canvas; shortcuts back to docked panels */}
			<Dock entries={dockEntries} onJump={jumpToPanel} onRemove={removeDockEntry} onRename={renameDockEntry} onPing={pingDockEntry} onParticipantDoubleClick={handleParticipantDoubleClick} onShowAll={showAll} />
		</div>
	);
}
