# watchtogether

A live peer-to-peer workspace for video chat, shared media, drawing and music
collaboration. Create a room, share its link and work together without an
account.

Rooms support up to four people. Media and collaborative state travel directly
between participants over WebRTC; PeerJS Cloud is used for signalling.

## Current features

### Rooms and video

- Up to four participants in a full peer-to-peer mesh
- Compact portrait camera and microphone panels for each participant
- Local microphone mute and camera on/off controls without leaving the room
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
- Draw rectangles, ellipses, straight lines and arrows, with Shift-constrained proportions and angles
- Connect shared panels with attached lines that follow them as they move or resize
- Clear the shared whiteboard
- Resolution-independent coordinates so content maps between different screen
  sizes
- Mouse, touch and mobile Safari interaction support
- Automatic local snapshots of drawings, widgets, layout, connectors and navigation

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
- **Canvas recorder** — record the visible board, drawings, connectors and
  panels through an in-app compositor without a screen-share prompt; share
  clips and synchronize their playback
- **Images and screenshots** — paste, drop or upload an image into a shared,
  resizable panel; large files are resized and compressed before transfer
- **Video panels** — one independently movable panel per participant

Widgets can be dragged from their non-interactive surfaces, resized from every
edge or corner, layered consistently across peers and tagged with a double
click.

### Sharing and navigation

- A shared dock acts as a set of bookmarks into the canvas
- Tag, rename, remove and jump to panels without relocating them
- Ping a dock entry to draw the other participants' attention
- See named, colour-coded participant cursors and toggle a fading laser trail
- Double-click a participant in the dock to request their current viewport, or
  offer yours; applying a suggested view always requires explicit acceptance
- Hold the canvas to create a position flag with a ripple
- Select and tag an area, then return to it with a framed zoom
- Invite the room to follow your viewport in an opt-in presentation mode;
  followers can leave at any time
- Paste images, plain text, YouTube links and other URLs directly onto the canvas
- Drop image and audio files and transfer them to peers in chunks with progress feedback
- Export the shared workspace as a portable JSON bundle and import it later;
  media filenames and playback metadata are included, but media bytes remain local
- Late joiners and reconnecting participants receive the current room snapshot
  and available media from the host over the P2P connection
- Summon a participant via Message, WhatsApp, Email or a copied link — uses the native share sheet on mobile

### Session continuity

- Room layout, drawings, notes, code, dock entries and viewport are saved in
  the browser and restored when that browser revisits the room
- Audio files and completed canvas recordings are retained locally in IndexedDB
- A participant joining an active room receives the current room snapshot and
  transferred media from the host

## Important current limitations

- **Persistence is browser-local.** Room snapshots are stored in `localStorage`
  and media files in IndexedDB. There is no shared application database, so a
  room cannot be recovered on a different browser unless a participant imports
  a previously exported bundle; bundle files contain media metadata, not bytes.
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

See [ROADMAP.md](ROADMAP.md) for cloud persistence, music mode, live screen
sharing and other feature candidates.

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
- Whiteboard strokes, shapes, text, connectors and clearing
- Sticky-note and code-editor updates
- Dock tags, labels and pings
- Position and bounded-area tags
- Room snapshots, imports, viewport handoffs and presentation-mode updates
- Ephemeral participant cursor and laser-pointer positions
- Chunked image, audio-file and recording transfers
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

Rooms are currently persisted only in the browser that used them. A versioned
snapshot in `localStorage` holds the board and layout, while IndexedDB holds
local image, audio and recorder files. The host also uses that snapshot format
to hydrate late joiners and room-bundle imports.

Supabase is **not currently wired into the application**. Cross-browser,
account-backed persistence would still require:

- A schema and migrations, normally stored under `supabase/migrations/`
- Client configuration and public project environment variables
- Authorization and room access policies
- Background snapshot writes and database hydration
- A media-storage policy if files should travel with portable room backups

The intended architecture is for live collaboration to remain P2P while a
database stores durable snapshots in the background.

## Production deployment

`npm run build` writes the static production application to `dist/`. It can be
served by Netlify, Vercel or another static host.

Production hosting must use HTTPS for camera, microphone and WebRTC browser
APIs. Configure the TURN environment variables before building because Vite
injects them at build time.

No application backend is required for the current browser-local version, but
the app still depends on third-party network services such as PeerJS signalling,
configured STUN/TURN infrastructure, YouTube and any pages opened in the mini
browser.

## Project structure

```text
src/
├── components/
│   ├── AudioPlayer.tsx        # shared record-player widget
│   ├── BrowserWidget.tsx      # synchronized iframe browser
│   ├── CodeWidget.tsx         # shared code editor and formatter
│   ├── Dock.tsx               # canvas bookmarks and participant shortcuts
│   ├── DraggablePanel.tsx     # movement, resizing and tag gestures
│   ├── ImageWidget.tsx        # pasted, dropped and uploaded images
│   ├── ScreenRecorderWidget.tsx # local display capture and shared playback
│   ├── StickyNote.tsx         # text, chord and tab notes
│   ├── SummonButton.tsx       # invite participant via Message, WhatsApp, Email or copied link
│   ├── VideoGrid.tsx          # side-by-side local and remote video
│   ├── VideoPanel.tsx         # local and remote video
│   ├── Whiteboard.tsx         # drawing, shapes, text and region selection
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
    ├── code.ts
    ├── fileTransfer.ts
    ├── image.ts
    ├── roomBundle.ts
    ├── roomCode.ts
    ├── roomPersistence.ts
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
