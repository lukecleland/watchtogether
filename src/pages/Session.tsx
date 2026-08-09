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
import { DraggablePanel } from '../components/DraggablePanel';
import { Whiteboard, type WhiteboardHandle, type WhiteboardStroke, type WhiteboardText } from '../components/Whiteboard';
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

// ── Resolution-independent panel sync ────────────────────────────────────
// Panels are stored / rendered in local CSS pixels. Before sending over the
// wire we convert to viewport fractions (0–1) so the remote peer can place
// them proportionally on their own (possibly different-resolution) screen.
function normalisePanel(s: PanelState): PanelState {
	return {
		x: s.x / window.innerWidth,
		y: s.y / window.innerHeight,
		width: s.width / window.innerWidth,
		height: s.height / window.innerHeight,
		z: s.z
	};
}

function denormalisePanel(s: PanelState): PanelState {
	return {
		x: s.x * window.innerWidth,
		y: s.y * window.innerHeight,
		width: s.width * window.innerWidth,
		height: s.height * window.innerHeight,
		z: s.z
	};
}
// ─────────────────────────────────────────────────────────────────────────

function defaultFixedPanels(): Record<PanelId, PanelState> {
	const vw = window.innerWidth;
	const isMobile = vw < 640;

	if (isMobile) {
		// On mobile: narrower panels, stacked vertically, extra top offset for notch
		const videoW = Math.min(vw - 32, 320);
		const videoH = Math.round((videoW * 9) / 16);
		// Clears the top bar, the typical iOS safe-area inset, and the tool island
		// that now sits centred beneath the bar
		const topY = 156;
		return {
			local: { x: 16, y: topY, width: videoW, height: videoH, z: 10 },
			remote: {
				x: 16,
				y: topY + videoH + 12,
				width: videoW,
				height: videoH,
				z: 10
			}
		};
	}

	const videoW = Math.min(420, Math.floor((vw - 80) / 2));
	const videoH = Math.round((videoW * 9) / 16);
	const topY = 112; // below the top bar and the tool island beneath it
	return {
		local: { x: videoW + 40, y: topY, width: videoW, height: videoH, z: 10 },
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
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [mediaError, setMediaError] = useState<string | null>(null);
	const [fixedPanels, setFixedPanels] = useState<Record<PanelId, PanelState>>(defaultFixedPanels);
	const [remotePanelStates, setRemotePanelStates] = useState<Record<string, PanelState>>({});
	const [dynamicPanels, setDynamicPanels] = useState<DynamicPanel[]>([]);
	const [positionTags, setPositionTags] = useState<PositionTag[]>([]);
	const positionTagsRef = useRef<PositionTag[]>([]);
	positionTagsRef.current = positionTags;
	// Tracks the highest z-index currently in use so we can raise panels on click
	const topZRef = useRef(20);
	// Background drag-over indicator
	const [bgDragOver, setBgDragOver] = useState(false);
	// The "nobody here yet" nudge. Dismissing it is final for the session —
	// being told twice how to invite someone is worse than not being told.
	const [summonPromptDismissed, setSummonPromptDismissed] = useState(false);
	const [widgetMenuOpen, setWidgetMenuOpen] = useState(false);
	const widgetMenuRef = useRef<HTMLDivElement>(null);

	// Ref for the outer container div — used to attach native touch listeners
	const containerRef = useRef<HTMLDivElement>(null);
	// Two-touch gesture state for pinch-to-zoom + two-finger pan
	const gestureRef = useRef<{
		lastDist: number;
		lastMid: { x: number; y: number };
	} | null>(null);

	// ── Infinite canvas transform ────────────────────────────────────────────
	const [canvas, setCanvas] = useState({ x: 0, y: 0, scale: 1 });
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
	const [dockedIds, setDockedIds] = useState<string[]>([]);
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
	const [panelLabels, setPanelLabels] = useState<Record<string, string>>({});
	// User-set chip names. Take precedence over the derived label above, and
	// survive the underlying content changing — if you named it, you meant it.
	const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
	// In-flight "fly to panel" animation, so a second jump cancels the first
	const jumpAnimRef = useRef<number | null>(null);

	// Whiteboard
	const whiteboardRef = useRef<WhiteboardHandle>(null);
	const [wbTool, setWbTool] = useState<'pointer' | 'pen' | 'eraser' | 'text' | 'region'>('pointer');
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

	const { remoteStreams, dataConnection, participantCount, status, error } = usePeer({
		roomCode,
		isHost,
		localStream
	});
	dataConnectionRef.current = dataConnection;

	useEffect(() => {
		setRemotePanelStates(prev => {
			const next: Record<string, PanelState> = {};
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

	// Panel sync — wired to the same data channel as YouTube sync
	const handleRemoteSync = useCallback((msg: SyncMessage) => {
		// Every message that carries panel geometry carries a z with it
		if ('state' in msg) noteRemoteZ(msg.state.z);

		if (msg.type === 'panel-update') {
			const remotePeerId = peerIdFromPanelId(msg.id);
			if (remotePeerId) {
				setRemotePanelStates(prev => ({
					...prev,
					[remotePeerId]: denormalisePanel(msg.state)
				}));
			} else if (msg.id === 'local' || msg.id === 'remote') {
				// Swap local ↔ remote so each user's "You" drives the other's "Guest"
				const targetId: PanelId = msg.id === 'local' ? 'remote' : 'local';
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
		} else if (msg.type === 'remove-panel') {
			setDynamicPanels(prev => prev.filter(p => p.id !== msg.id));
			// The panel is gone, so any local dock chip pointing at it must go too
			forgetPanel(msg.id);
		} else if (msg.type === 'position-tag') {
			// x/y/w/h arrive world-normalised; scale by our own viewport, exactly
			// as the sender divided by theirs.
			const tag: PositionTag = {
				...(msg.w !== undefined && msg.h !== undefined
					? { w: msg.w * window.innerWidth, h: msg.h * window.innerHeight }
					: {}),
				id: msg.id,
				x: msg.x * window.innerWidth,
				y: msg.y * window.innerHeight,
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
				setDynamicPanels(prev =>
					prev.map(p => (p.id === done.meta.panelId ? { ...p, initialFile: done.file } : p))
				);
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
		} else if (msg.type === 'draw-text') {
			whiteboardRef.current?.drawText({ ...msg, kind: 'text', id: msg.id, font: msg.font as TextFont });
		} else if (msg.type === 'text-edit') {
			whiteboardRef.current?.editText(msg.id, msg.text);
		} else if (msg.type === 'draw-clear') {
			whiteboardRef.current?.clearCanvas();
		}
	}, [forgetPanel, startPulse, noteRemoteZ]);

	// We use useYouTubeSync here to route panel-update and whiteboard messages.
	// YoutubeWidget mounts its own useYouTubeSync instance for YT playback messages.
	const { sendSync } = useYouTubeSync({
		dataConnection,
		onRemoteSync: handleRemoteSync
	});

	const sendPanelUpdate = useCallback(
		(id: string, state: PanelState) => {
			sendSync({ type: 'panel-update', id, state: normalisePanel(state) });
		},
		[sendSync]
	);

	const handleWbStroke = useCallback(
		(stroke: WhiteboardStroke) => {
			sendSync({ type: 'draw', ...stroke });
		},
		[sendSync]
	);

	const handleWbText = useCallback(
		(item: WhiteboardText) => {
			sendSync({ type: 'draw-text', id: item.id, x: item.x, y: item.y, text: item.text, color: item.color, size: item.size, font: item.font });
		},
		[sendSync]
	);

	const handleWbTextEdit = useCallback(
		(id: string, text: string) => {
			sendSync({ type: 'text-edit', id, text });
		},
		[sendSync]
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
				x: r.x,
				y: r.y,
				w: r.w / window.innerWidth,
				h: r.h / window.innerHeight,
				label: tag.label
			});
			sendSync({ type: 'dock-tag', id });
		},
		[sendSync]
	);

	// Stream a file to the peer for an already-spawned panel
	const sendFileTo = useCallback(
		(panelId: string, file: File) => {
			const transferId = crypto.randomUUID();
			transferPanelRef.current[transferId] = panelId;
			sendSync({
				type: 'file-begin',
				transferId,
				panelId,
				fileName: file.name,
				mimeType: file.type,
				size: file.size,
				chunks: chunkCount(file.size)
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

	const handleWbClear = useCallback(() => {
		whiteboardRef.current?.clearCanvas();
		sendSync({ type: 'draw-clear' });
	}, [sendSync]);

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
		setDynamicPanels(prev => prev.filter(p => p.id !== id));
		forgetPanel(id);
		sendSync({ type: 'remove-panel', id });
	};

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
		if (positionTags.some(tag => tag.id === id)) {
			setPositionTags(prev => prev.filter(tag => tag.id !== id));
			forgetPanel(id);
			sendSync({ type: 'position-tag-remove', id });
			return;
		}
		toggleDock(id);
	};

	// Fly the viewport so the given panel sits in the middle of the screen at a
	// size that's actually usable for its content. The panel itself never moves
	// — the dock is navigation, not relocation; only the viewport changes.
	const jumpToPanel = (id: string) => {
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
		const base = panel.type === 'youtube' ? 'YouTube' : panel.type === 'note' ? 'Note' : panel.type === 'browser' ? 'Browser' : panel.type === 'code' ? 'Code' : 'Audio';
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
		type: 'youtube' | 'audio' | 'browser' | 'note' | 'code',
		screenX: number,
		screenY: number,
		extra?: { initialVideoId?: string; initialFile?: File; initialUrl?: string; note?: NoteContent; code?: CodeContent },
		remoteId?: string
	) => {
		const { x: tx, y: ty, scale } = canvasStateRef.current;
		const w = type === 'browser' ? 560 : type === 'code' ? 520 : type === 'youtube' ? 320 : type === 'note' ? 300 : 300;
		const h = type === 'browser' ? 420 : type === 'code' ? 380 : type === 'youtube' ? 260 : type === 'note' ? 300 : 360;
		const worldX = (screenX - tx) / scale - w / 2;
		const worldY = (screenY - ty) / scale - h / 2;
		const nextZ = ++topZRef.current;
		const id = remoteId ?? crypto.randomUUID();
		const state: PanelState = { x: worldX, y: worldY, width: w, height: h, z: nextZ };
		setDynamicPanels(prev => [...prev, { id, type, state, ...extra }]);

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
			}
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
	// sensible thing: a YouTube link becomes a player, any other link becomes a
	// browser panel, and plain text becomes canvas text.
	//
	// Images are deliberately not handled yet. There is no image support on the
	// canvas, and pasting a screengrab would hit the same wall the audio drop
	// already does — the whole file base64'd into a single data-channel message.
	// That wants the chunked transfer work first, which stickers and image drop
	// both need too.
	const pointerRef = useRef({ x: 0, y: 0 });
	useEffect(() => {
		const onPointer = (e: PointerEvent) => {
			pointerRef.current = { x: e.clientX, y: e.clientY };
		};
		window.addEventListener('pointermove', onPointer);
		return () => window.removeEventListener('pointermove', onPointer);
	}, []);

	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			if (e.defaultPrevented) return;
			// Never hijack a paste aimed at a note, the rename box or a URL bar.
			// The target is only an Element when something is focused — a paste
			// with focus on the document itself reports the window.
			const el = e.target instanceof Element ? e.target : null;
			if (el?.closest('input, textarea, [contenteditable="true"]')) return;

			const raw = e.clipboardData?.getData('text')?.trim();
			if (!raw) return;
			e.preventDefault();

			// Drop it where the pointer is; fall back to the middle of the screen
			// when pasted by keyboard without the mouse having moved.
			const { x, y } = pointerRef.current;
			const px = x || window.innerWidth / 2;
			const py = y || window.innerHeight / 2;

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
				x: tag.x / window.innerWidth,
				y: tag.y / window.innerHeight,
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
			{/* Top bar — fixed overlay, not part of draggable canvas */}
			<div
				className="absolute top-0 left-0 right-0 z-50 flex items-end justify-between px-2 sm:px-4 bg-zinc-950/90 backdrop-blur-sm border-b border-zinc-800/60"
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
				</div>

				{/* Add media buttons (desktop) */}
				<div className="hidden sm:flex items-center gap-1.5 shrink-0">
					<button
						onClick={() => spawnPanel('note', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex items-center gap-1 sm:gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
						title="Add a sticky note">
						<svg className="w-3.5 h-3.5 text-amber-300 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M5 3h14a2 2 0 012 2v9l-7 7H5a2 2 0 01-2-2V5a2 2 0 012-2zm9 17.5V15a1 1 0 011-1h5.5L14 20.5z" />
						</svg>
						<span className="hidden sm:inline">Note</span>
					</button>
					<button
						onClick={() => spawnPanel('code', window.innerWidth / 2, window.innerHeight / 2, { code: { text: '', language: 'text' } })}
						className="flex items-center gap-1 sm:gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
						title="Add a code editor">
						<span className="font-mono text-emerald-400">&lt;/&gt;</span>
						<span className="hidden sm:inline">Code</span>
					</button>
					<button
						onClick={() => spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex items-center gap-1 sm:gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
						title="Add a YouTube player">
						<svg className="w-3.5 h-3.5 text-red-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
						</svg>
						<span className="hidden sm:inline">YouTube</span>
					</button>
					<button
						onClick={() => spawnPanel('audio', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex items-center gap-1 sm:gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
						title="Add an audio player">
						<svg className="w-3.5 h-3.5 text-violet-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
						</svg>
						<span className="hidden sm:inline">Audio</span>
					</button>
					<button
						onClick={() => spawnPanel('browser', window.innerWidth / 2, window.innerHeight / 2)}
						className="flex items-center gap-1 sm:gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
						title="Add a mini browser">
						<svg className="w-3.5 h-3.5 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<path d="M3 9h18M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
						</svg>
						<span className="hidden sm:inline">Browser</span>
					</button>
				</div>

				{/* Add media buttons (mobile hamburger) */}
				<div ref={widgetMenuRef} className="relative sm:hidden shrink-0">
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

				{/* Anyone in the room can summon, not just whoever opened it — a
				    room holds four, so a guest may well be the one who wants to
				    pull in the fourth. */}
				<SummonButton roomCode={roomCode} />
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
					style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom) + 6rem)' }}>
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
				onStroke={handleWbStroke}
				onText={handleWbText}
				onTextEdit={handleWbTextEdit}
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
				onFontChange={setWbFont}
				onTextSizeChange={setWbTextSize}
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
					<DraggablePanel state={fixedPanels.local} {...makePanelHandlers('local')} onToggleDock={() => toggleDock('local')} minWidth={200} minHeight={120} scale={canvas.scale} className="z-10">
						{zoomTagHandle('local', 'You')}
						{/* No onToggleDock: participants are permanently docked, so a
						    bookmark toggle here would be a button that does nothing */}
						<VideoPanel stream={localStream} label="You" muted docked={dockedIds.includes('local')} />
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
								label={label}
								docked={dockedIds.includes(panelId)}
							/>
						</DraggablePanel>
					);
				})}

				{dynamicPanels.map(panel => (
					<DraggablePanel
						key={panel.id}
						state={panel.state}
						{...makeDynamicPanelHandlers(panel.id)}
						onToggleDock={() => toggleDock(panel.id)}
						minWidth={panel.type === 'browser' ? 360 : panel.type === 'code' ? 380 : panel.type === 'youtube' ? 280 : 260}
						minHeight={panel.type === 'browser' ? 240 : panel.type === 'audio' ? 300 : 60}
						scale={canvas.scale}>
						{zoomTagHandle(panel.id, panelLabels[panel.id] ?? fallbackLabel(panel))}
						{panel.type === 'note' ? (
							<StickyNote
								note={panel.note ?? defaultNoteContent()}
								onChange={next => updateNote(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'code' ? (
							<CodeWidget
								code={panel.code ?? { text: '', language: 'text' }}
								onChange={next => updateCode(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'youtube' ? (
							<YoutubeWidget
								id={panel.id}
								dataConnection={dataConnection}
								initialVideoId={panel.initialVideoId}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
							/>
						) : panel.type === 'audio' ? (
							<AudioPlayer
								id={panel.id}
								dataConnection={dataConnection}
								initialFile={panel.initialFile}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTrackChange={name => setPanelLabels(prev => ({ ...prev, [panel.id]: name }))}
								transferProgress={transferProgress[panel.id]}
								onFileChosen={file => sendFileTo(panel.id, file)}
							/>
						) : (
							<BrowserWidget
								id={panel.id}
								dataConnection={dataConnection}
								initialUrl={panel.initialUrl}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
							/>
						)}
					</DraggablePanel>
				))}
			</div>

			{/* Dock — fixed overlay above the canvas; shortcuts back to docked panels */}
			<Dock entries={dockEntries} onJump={jumpToPanel} onRemove={removeDockEntry} onRename={renameDockEntry} onPing={pingDockEntry} />
		</div>
	);
}
