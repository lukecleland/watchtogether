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
import { DraggablePanel } from '../components/DraggablePanel';
import { Whiteboard, type WhiteboardHandle, type WhiteboardStroke } from '../components/Whiteboard';
import { WhiteboardToolbar } from '../components/WhiteboardToolbar';
import { Dock, type DockEntry } from '../components/Dock';
import { usePeer } from '../hooks/usePeer';
import { useYouTubeSync, type SyncMessage } from '../hooks/useYouTubeSync';
import type { PanelId, PanelState, DynamicPanel } from '../types/panels';

interface SessionProps {
	roomCode: string;
	isHost: boolean;
}

interface PositionTag {
	id: string;
	x: number;
	y: number;
	label: string;
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
		const topY = 100; // clear the top bar including typical iOS safe-area inset
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
	const topY = 56; // below the top bar
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
	const [dynamicPanels, setDynamicPanels] = useState<DynamicPanel[]>([]);
	const [positionTags, setPositionTags] = useState<PositionTag[]>([]);
	const positionTagsRef = useRef<PositionTag[]>([]);
	positionTagsRef.current = positionTags;
	// Tracks the highest z-index currently in use so we can raise panels on click
	const topZRef = useRef(20);
	// Background drag-over indicator
	const [bgDragOver, setBgDragOver] = useState(false);

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
	// Bookmarks the peer tagged that we haven't acknowledged yet — these pulse.
	const [pulsingIds, setPulsingIds] = useState<string[]>([]);
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
	const [wbTool, setWbTool] = useState<'pen' | 'eraser'>('pen');
	const [wbColor, setWbColor] = useState('#ffffff');
	const [wbWidth, setWbWidth] = useState(3);

	const { remoteStream, dataConnection, status, error } = usePeer({
		roomCode,
		isHost,
		localStream
	});

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
		if (msg.type === 'panel-update') {
			if (msg.id === 'local' || msg.id === 'remote') {
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
		} else if (msg.type === 'spawn-audio') {
			let initialFile: File | undefined;
			if (msg.dataB64 && msg.fileName && msg.mimeType) {
				const binaryStr = atob(msg.dataB64);
				const bytes = new Uint8Array(binaryStr.length);
				for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
				initialFile = new File([bytes], msg.fileName, { type: msg.mimeType });
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
		} else if (msg.type === 'remove-panel') {
			setDynamicPanels(prev => prev.filter(p => p.id !== msg.id));
			// The panel is gone, so any local dock chip pointing at it must go too
			forgetPanel(msg.id);
		} else if (msg.type === 'position-tag') {
			const tag: PositionTag = {
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
		} else if (msg.type === 'draw') {
			whiteboardRef.current?.drawStroke(msg);
		} else if (msg.type === 'draw-clear') {
			whiteboardRef.current?.clearCanvas();
		}
	}, [forgetPanel, startPulse]);

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
			setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, state: { ...p.state, z: nextZ } } : p)));
		}
	});

	const removePanel = (id: string) => {
		setDynamicPanels(prev => prev.filter(p => p.id !== id));
		forgetPanel(id);
		sendSync({ type: 'remove-panel', id });
	};

	// Tagging is shared; untagging is not. Removing a chip clears it from your
	// own bar only — nobody gets to delete a bookmark out of the other's UI.
	const toggleDock = (id: string) => {
		// The send stays outside the state updater — StrictMode invokes updaters
		// twice, which would tag the peer twice.
		if (dockedIds.includes(id)) {
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
		const panel = isFixed ? null : dynamicPanels.find(p => p.id === id);
		const target = positionTag
			? { x: positionTag.x, y: positionTag.y, width: 0, height: 0, z: 0 }
			: isFixed
				? fixedPanels[id]
				: panel?.state;
		if (!target) return;

		const type: DockEntry['type'] = positionTag ? 'position' : isFixed ? id : (panel?.type ?? 'youtube');
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
			position: 0
		};

		// Start from the ideal width, then make sure the whole panel still fits
		// on screen with a margin, and stay inside the app's zoom limits.
		const fitScale = positionTag ? canvasStateRef.current.scale : Math.min((vw * 0.9) / target.width, (vh * 0.85) / target.height);
		const idealScale = positionTag ? canvasStateRef.current.scale : IDEAL_ON_SCREEN_WIDTH[type] / target.width;
		const toScale = positionTag ? canvasStateRef.current.scale : Math.max(0.25, Math.min(4, fitScale, idealScale));

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

	// Cancel any in-flight jump and pending pulse timers on unmount
	useEffect(() => {
		const pulseTimers = pulseTimersRef.current;
		return () => {
			if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);
			Object.values(pulseTimers).forEach(clearTimeout);
		};
	}, []);

	// Fallback dock label for a panel with nothing yet to name itself after (no
	// video loaded, no file chosen). Numbered only when more than one of that
	// type exists, so a lone panel reads "YouTube" rather than "YouTube 1".
	const fallbackLabel = (panel: DynamicPanel): string => {
		const base = panel.type === 'youtube' ? 'YouTube' : 'Audio';
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
	const spawnPanel = (type: 'youtube' | 'audio', screenX: number, screenY: number, extra?: { initialVideoId?: string; initialFile?: File }, remoteId?: string) => {
		const { x: tx, y: ty, scale } = canvasStateRef.current;
		const w = type === 'youtube' ? 320 : 300;
		const h = type === 'youtube' ? 260 : 175;
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
			} else if (type === 'audio') {
				if (extra?.initialFile) {
					const file = extra.initialFile;
					const reader = new FileReader();
					reader.onload = () => {
						const bytes = new Uint8Array(reader.result as ArrayBuffer);
						let binary = '';
						for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
						sendSync({ type: 'spawn-audio', id, fileName: file.name, mimeType: file.type, dataB64: btoa(binary), state: normalisePanel(state) });
					};
					reader.readAsArrayBuffer(file);
				} else {
					// Empty audio panel (no file yet)
					sendSync({ type: 'spawn-audio', id, state: normalisePanel(state) });
				}
			}
		}
	};

	useEffect(() => {
		const handleClipboardPaste = (e: ClipboardEvent) => {
			// The YouTube widget has its own paste handler. Likewise, never
			// hijack clipboard input from any other editable control.
			if (e.defaultPrevented) return;
			const target = e.target as HTMLElement | null;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target?.isContentEditable
			)
				return;

			const videoId = parseYouTubeVideoId(e.clipboardData?.getData('text/plain') ?? '');
			if (!videoId) return;

			e.preventDefault();
			spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2, {
				initialVideoId: videoId
			});
		};

		document.addEventListener('paste', handleClipboardPaste);
		return () => document.removeEventListener('paste', handleClipboardPaste);
	});

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

	// Middle or right-click drag pans without space held
	const handleOuterMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.button === 1 || e.button === 2) {
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

	const copyCode = () => {
		navigator.clipboard.writeText(window.location.href).catch(() => {
			navigator.clipboard.writeText(roomCode);
		});
	};

	const statusLabel: Record<string, string> = {
		idle: 'Setting up…',
		connecting: 'Connecting…',
		waiting: 'Waiting for guest…',
		connected: 'Connected',
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
				if (isPanningRef.current) e.preventDefault();
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

				{/* Add media buttons */}
				<div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
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
				</div>

				{isHost && (
					<button
						onClick={copyCode}
						className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-mono px-2 sm:px-3 py-1.5 rounded-lg transition-colors shrink-0"
						title="Copy invite link">
						<span className="hidden sm:inline">{roomCode}</span>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
							/>
						</svg>
					</button>
				)}
			</div>

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
			<Whiteboard ref={whiteboardRef} tool={wbTool} color={wbColor} width={wbWidth} onStroke={handleWbStroke} canvasTransform={canvas} />

			{/* Whiteboard toolbar */}
			<WhiteboardToolbar tool={wbTool} color={wbColor} width={wbWidth} onToolChange={setWbTool} onColorChange={setWbColor} onWidthChange={setWbWidth} onClear={handleWbClear} />

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
				{positionTags.map(tag => (
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
				))}
				{localStream && localStream.getTracks().length > 0 && (
					<DraggablePanel state={fixedPanels.local} {...makePanelHandlers('local')} minWidth={200} minHeight={120} scale={canvas.scale} className="z-10">
						<VideoPanel stream={localStream} label="You" muted docked={dockedIds.includes('local')} onToggleDock={() => toggleDock('local')} />
					</DraggablePanel>
				)}

				{status === 'connected' && (
					<DraggablePanel state={fixedPanels.remote} {...makePanelHandlers('remote')} minWidth={200} minHeight={120} scale={canvas.scale} className="z-10">
						<VideoPanel stream={remoteStream} label="Guest" docked={dockedIds.includes('remote')} onToggleDock={() => toggleDock('remote')} />
					</DraggablePanel>
				)}

				{dynamicPanels.map(panel => (
					<DraggablePanel
						key={panel.id}
						state={panel.state}
						{...makeDynamicPanelHandlers(panel.id)}
						minWidth={panel.type === 'youtube' ? 280 : 260}
						minHeight={60}
						scale={canvas.scale}>
						{panel.type === 'youtube' ? (
							<YoutubeWidget
								dataConnection={dataConnection}
								initialVideoId={panel.initialVideoId}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
							/>
						) : (
							<AudioPlayer
								id={panel.id}
								dataConnection={dataConnection}
								initialFile={panel.initialFile}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTrackChange={name => setPanelLabels(prev => ({ ...prev, [panel.id]: name }))}
							/>
						)}
					</DraggablePanel>
				))}
			</div>

			{/* Dock — fixed overlay above the canvas; shortcuts back to docked panels */}
			<Dock entries={dockEntries} onJump={jumpToPanel} onRemove={removeDockEntry} onRename={renameDockEntry} />
		</div>
	);
}
