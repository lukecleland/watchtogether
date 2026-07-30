# watchtogether

A real-time peer-to-peer room for up to four people, with video chat, shared media widgets, and a collaborative whiteboard — no login or install.

Built with React + TypeScript + Vite. Peer connections are handled entirely in the browser via WebRTC (PeerJS). The only external service used is PeerJS Cloud for signaling.

---

## Features

- **Video call** — camera + microphone for up to four participants, with data-only fallback when media is unavailable
- **Synchronized YouTube** — paste a URL or video ID; play, pause, and seek stay in lock-step for everyone
- **Collaborative whiteboard** — draw together in real time on the shared canvas background; pen, eraser, 8 colours, 3 brush sizes, clear
- **Draggable + resizable panels** — video feeds and YouTube widget can be freely repositioned and resized; layout syncs between peers
- **Resolution-independent** — panel positions and whiteboard strokes are all normalised to viewport fractions, so everything lands correctly regardless of each peer's screen size or DPR
- **Dictionary room codes** — sessions get a memorable uppercase word (e.g. `THUNDER`) shared via URL param `?room=THUNDER`
- **No login** — share the link, join, go

---

## How it works

### Connection model

```
          Host
        ╱  │  ╲
 Guest ─ Guest ─ Guest
```

- The **host** generates a room code word, registers as a PeerJS peer with that ID (lowercased), and waits.
- Guests visit the shared URL (`?room=WORD`). The host distributes the current roster and the browsers form a full WebRTC mesh, capped at four people.
- Once connected, application data and media travel directly between browsers. PeerJS Cloud is used for signaling; a configured TURN service may relay WebRTC traffic when a direct route is unavailable.

### Data channel messages

Everything synced over the wire is a tagged union (`SyncMessage`):

| `type`         | Payload                                  | Purpose                             |
| -------------- | ---------------------------------------- | ----------------------------------- |
| `load`         | `videoId`                                | Load a new YouTube video            |
| `play`         | `time`                                   | Seek + play from timestamp          |
| `pause`        | `time`                                   | Seek + pause at timestamp           |
| `seek`         | `time`                                   | Seek without changing play state    |
| `panel-update` | `id`, `state` (normalised 0–1 fractions) | Move/resize/z-order a panel         |
| `draw`         | `x0 y0 x1 y1 color width` (normalised)   | Whiteboard stroke segment           |
| `draw-clear`   | —                                        | Clear the whiteboard for both peers |

Two separate `useYouTubeSync` instances share the same data connection:

1. **Session.tsx** handles `panel-update`, `draw`, and `draw-clear`.
2. **YoutubeWidget.tsx** handles `load`, `play`, `pause`, and `seek`.

PeerJS fires `conn.on("data")` once per connection object; each instance sees every message and ignores types it doesn't own.

### YouTube echo prevention

When a remote `play` or `pause` arrives, calling `seekTo()` + `playVideo()` causes the YouTube IFrame API to fire `onStateChange` events — which would echo back to the remote peer, creating a feedback loop. This is suppressed with a **time-window guard**: `syncUntilRef` is set 500 ms into the future on any remote-triggered command, and all `onStateChange` events fired within that window are silently ignored.

### Resolution independence

All values that cross the wire are normalised:

- **Panel positions/sizes** — divided by `innerWidth`/`innerHeight` before sending; multiplied back on receipt using the receiver's own dimensions.
- **Whiteboard strokes** — `x`/`y` as fractions of viewport; `width` as a fraction of `Math.min(viewport W, H)`.
- **Canvas DPR** — the `<canvas>` buffer is sized to `innerWidth × devicePixelRatio`, so strokes are sharp on Retina/HiDPI screens.

---

## Project structure

```
src/
├── App.tsx                    # Top-level router (Home ↔ Session)
├── pages/
│   ├── Home.tsx               # Start/join UI
│   └── Session.tsx            # Session coordinator — owns all shared state
├── components/
│   ├── DraggablePanel.tsx     # Controlled drag + resize wrapper (react-draggable)
│   ├── VideoPanel.tsx         # Single video feed with title bar
│   ├── YoutubeWidget.tsx      # YouTube player + URL input + sync logic
│   ├── Whiteboard.tsx         # Full-screen canvas whiteboard
│   └── WhiteboardToolbar.tsx  # Draggable tool palette (pen/eraser/colour/size)
├── hooks/
│   ├── usePeer.ts             # PeerJS lifecycle — media call + data channel
│   ├── useYouTubePlayer.ts    # Stable YouTube IFrame API wrapper (no react-youtube)
│   └── useYouTubeSync.ts      # Data channel message router + sender
├── types/
│   └── panels.ts              # PanelId, PanelState
└── utils/
    ├── roomCode.ts            # Generate / read / write room codes
    └── wordList.ts            # ~150 dictionary words for room code generation
```

---

## Running locally

```bash
npm install
npm run dev
```

Open two browser tabs (or two different browsers) — start a session in one, paste the URL in the other.

To build for production:

```bash
npm run build
```

The output in `dist/` is a fully static site — drop it on Netlify, Vercel, GitHub Pages, or any static host.

### Reliable mobile-to-mobile connections

The PeerJS cloud service handles signaling only. For two phones on cellular or
restrictive Wi-Fi, configure a TURN relay so WebRTC has a route when a direct
STUN connection is blocked:

```bash
cp .env.example .env.local
```

Set `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, and `VITE_TURN_CREDENTIAL` using
values from your TURN provider, then rebuild/redeploy. Prefer a provider that
supplies both UDP TURN and TLS/TCP TURN on port 443. The app tries direct P2P
first and uses the relay only when necessary.

Because Vite embeds `VITE_*` values into the browser bundle, use short-lived
TURN credentials in production where your provider supports them. Do not put a
TURN provider's account/API secret in these variables.

---

## Tech stack

| Library               | Purpose                    |
| --------------------- | -------------------------- |
| React 18 + TypeScript | UI + type safety           |
| Vite 8                | Build tooling              |
| Tailwind CSS v4       | Styling                    |
| PeerJS                | WebRTC signaling + helpers |
| react-draggable       | Panel drag behaviour       |

No backend required. PeerJS Cloud is used only for the initial WebRTC handshake (STUN/TURN + signaling); all media and data flows directly between browsers.

      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },

},
])

````

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
````
