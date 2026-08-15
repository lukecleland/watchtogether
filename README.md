# watchtogether

A live peer-to-peer workspace for video chat, shared media, drawing and music
collaboration. Create a room, share its link and work together without an
account.

Rooms support up to four people. Media and collaborative state travel directly
between participants over WebRTC; PeerJS Cloud is used for signalling.

## Current features

### Rooms and video

- Up to four participants in a full peer-to-peer mesh
- Camera and microphone video panels for each participant
- Data-only participation when camera or microphone access is denied or
  unavailable
- Automatic reconnection and room-owner handover when the original host leaves
- Participant video shortcuts kept in the shared dock
- Participant count and a clear room-full state for a fifth connection
- Per-participant microphone mute and camera controls

### Infinite collaborative canvas

- Pan and zoom around a shared dot-grid workspace
- Draw continuously behind and around floating panels
- Ballpoint, pencil, fountain pen, charcoal, highlighter, neon and eraser tools
- Adjustable colour, width and nib-specific rendering, including metallic inks
- Place and re-edit free text directly on the canvas
- Clear the shared whiteboard
- Resolution-independent coordinates so content maps between different screen
  sizes
- Mouse, touch and mobile Safari interaction support

### Shared widgets

- **YouTube player** — load links by pasting or dropping them onto the canvas;
  play, pause and seek state is shared
- **Record player** — load an audio file into an animated top-down turntable;
  play, pause and seek state is shared
- **Mini browser** — enter a URL and render sites that permit iframe embedding
- **Sticky notes** — switch between text, guitar chord diagrams and tablature;
  notes can contain multiple chords
- **Code editor** — write or paste syntax-highlighted snippets and format
  supported languages collaboratively
- **Screen recorder** — capture a screen or window locally, share the resulting
  clip with the room and synchronize its playback
- **Video panels** — one independently movable panel per participant

Widgets can be dragged from their non-interactive surfaces, resized from every
edge or corner, layered consistently across peers and tagged with a double
click.

### Sharing and navigation

- A shared dock acts as a set of bookmarks into the canvas
- Tag, rename, remove and jump to panels without relocating them
- Ping a dock entry to draw the other participants' attention
- Hold the canvas to create a position flag with a ripple
- Select and tag an area, then return to it with a framed zoom
- Invite the room to follow your viewport in an opt-in presentation mode;
  followers can leave at any time
- Paste plain text, YouTube links and other URLs directly onto the canvas
- Drop audio files and transfer them to peers in chunks with progress feedback
- Summon a participant via Message, WhatsApp, Email or a copied link — uses the native share sheet on mobile

### Session continuity

- Room layout, drawings, notes, code, dock entries and viewport are saved in
  the browser and restored when that browser revisits the room
- Audio files and completed screen recordings are retained locally in IndexedDB
- A participant joining an active room receives the current room snapshot and
  transferred media from the host

## Important current limitations

- **Persistence is local to each browser.** There is no application database.
  A saved room is not available on a new device unless someone with the room
  state is present to hydrate it, and clearing site data removes the local copy.
- **TURN is optional but operationally important.** Direct WebRTC can fail
  between cellular devices, strict NATs and restrictive corporate networks
  unless a TURN relay is configured.
- **Four participants is a deliberate ceiling.** A full mesh creates a direct
  media connection between every pair and does not scale like an SFU-backed
  conferencing system.
- **Mini-browser compatibility depends on the destination site.** Sites using
  `X-Frame-Options` or restrictive Content Security Policy headers cannot be
  embedded.
- **Browser media policies still apply.** iOS and other browsers may require a
  tap before remote audio can play, and autoplay restrictions can delay a
  remotely triggered player.

See [ROADMAP.md](ROADMAP.md) for cloud persistence, music mode, shapes, images,
live screen sharing and other feature candidates.

## Connection model

The room owner registers the lower-cased room code as its PeerJS ID. Guests
connect to that ID, receive the participant roster and establish the remaining
connections required for a full mesh:

```text
             Participant A
              /    |    \
             /     |     \
Participant B----- C -----D
```

Application messages are broadcast across the mesh, with message ids preventing
duplicates when peers relay them. Media calls and data channels remain direct
between browsers. If the room owner
disconnects, the remaining clients elect a replacement owner so the room code
continues to work while anyone remains connected.

STUN servers help browsers discover direct routes. A configured TURN server
relays encrypted WebRTC traffic only when a direct route cannot be established.

## Shared state

The WebRTC data channel carries typed messages for:

- Panel creation, movement, resizing, stacking and removal
- YouTube, audio and browser state
- Whiteboard strokes, text and clearing
- Sticky-note updates
- Dock tags, labels and pings
- Position and bounded-area tags
- Chunked audio-file transfers
- Room snapshots for late joiners
- Collaborative code and synchronized recording playback

Panel geometry and canvas coordinates are normalized before transmission so
participants with different viewport sizes still share the same logical
workspace. YouTube and audio playback commands include a wall-clock timestamp
so receivers can compensate for data-channel transit time.

## Local development

Requirements:

- Node.js 20 or newer
- npm
- A secure browser context for camera and microphone access (`localhost` is
  accepted by browsers)

Install dependencies and start Vite:

```bash
npm install
npm run dev
```

Open the displayed local URL, start a session and join it from up to three other
tabs, browsers or devices using the generated link.

Available commands:

```bash
npm run dev       # development server
npm run build     # TypeScript check and production build
npm run lint      # ESLint
npm run preview   # serve the production build locally
```

## TURN configuration

Copy the example environment file:

```bash
cp .env.example .env.local
```

Configure the UDP and TLS/TCP endpoints supplied by your TURN provider:

```dotenv
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp
VITE_TURN_USERNAME=replace-with-turn-username
VITE_TURN_CREDENTIAL=replace-with-turn-credential
```

Vite embeds `VITE_*` values in the client bundle. Do not place a provider's
account password or API secret in these variables. Prefer scoped or short-lived
TURN credentials when the provider supports them.

## Persistence

The application currently uses `localStorage` for room snapshots and IndexedDB
for media. Live collaboration remains peer-to-peer, and the host sends its
current snapshot to participants who join an active room.

Cloud persistence is not currently wired into the application. Adding it will
require:

- A schema and migrations, normally stored under `supabase/migrations/`
- Client configuration and public project environment variables
- A durable version of the existing session snapshot format
- Authorization and room access policies
- Hydration on initial join and reconnection

The intended architecture is for live collaboration to remain P2P while the
database stores durable snapshots in the background.

## Production deployment

`npm run build` writes the static production application to `dist/`. It can be
served by Netlify, Vercel or another static host.

Production hosting must use HTTPS for camera, microphone and WebRTC browser
APIs. Configure the TURN environment variables before building because Vite
injects them at build time.

No application backend is required for the current local-first version, but the
app still depends on third-party network services such as PeerJS signalling,
configured STUN/TURN infrastructure, YouTube and any pages opened in the mini
browser.

## Project structure

```text
src/
├── components/
│   ├── AudioPlayer.tsx        # shared record-player widget
│   ├── BrowserWidget.tsx      # synchronized iframe browser
│   ├── Dock.tsx               # canvas bookmarks and participant shortcuts
│   ├── DraggablePanel.tsx     # movement, resizing and tag gestures
│   ├── StickyNote.tsx         # text, chord and tab notes
│   ├── SummonButton.tsx       # invite participant via Message, WhatsApp, Email or copied link
│   ├── VideoGrid.tsx          # side-by-side local and remote video
│   ├── VideoPanel.tsx         # local and remote video
│   ├── Whiteboard.tsx         # drawing, text and region selection
│   ├── WhiteboardToolbar.tsx  # canvas tools and properties
│   └── YoutubeWidget.tsx      # YouTube loading and playback sync
├── hooks/
│   ├── usePeer.ts             # four-person PeerJS mesh and reconnection
│   ├── useYouTubePlayer.ts    # YouTube IFrame API wrapper
│   └── useYouTubeSync.ts      # shared data-channel message router
├── pages/
│   ├── Home.tsx               # create and join flow
│   └── Session.tsx            # canvas and shared-session coordinator
├── types/
│   └── panels.ts
└── utils/
    ├── brush.ts
    ├── fileTransfer.ts
    ├── roomCode.ts
    └── wordList.ts
```

## Technology

| Technology | Role |
| --- | --- |
| React 19 | User interface |
| TypeScript 6 | Static typing |
| Vite 8 | Development and production builds |
| Tailwind CSS 4 | Styling |
| PeerJS / WebRTC | Signalling helpers, media and data channels |
| YouTube IFrame API | Embedded video playback |
| react-draggable | Panel movement |
