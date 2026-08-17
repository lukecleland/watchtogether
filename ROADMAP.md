# watchtogether — roadmap

Working document, not a commitment — the ordering is open and items get rewritten
as we learn things from building them. Ticked items link to where they landed.

> **Documentation checkpoint (August 2026).** Four-person mesh rooms, local
> browser persistence, late-join hydration, panel-scoped YouTube playback,
> microphone/camera controls, collaborative code panels and screen recording
> are now implemented. Older notes below are retained where they explain design
> decisions, but their status has been updated.

The guiding principle: **peer-to-peer is the point.** The near-zero latency is
what makes the app genuinely usable for things like playing guitar together, and
media streams should stay direct between peers regardless of what else gets
added. So the work is split:

- **Phase 1 — P2P features.** No server, no database. Everything here rides the
  existing WebRTC data channel.
- **Phase 2 — persistence.** A database as the *durable* record only, written to
  in the background. The fast path stays P2P, so latency is unaffected.

---

## Phase 1 — P2P features

### Proposed features

- [x] **Free-type text on the canvas** — done (#10). Landed as a *canvas tool*
      rather than a spawned panel: the top bar spawns panels, the tool island
      acts on the canvas. A sticky note is a container; canvas text is a label,
      and wrapping one word in a bordered panel is too much furniture. Text is
      stored in the same ordered list as strokes so the eraser still works on
      it, and can be clicked to re-edit or cleared to delete.
- [x] **~~Pin items to a bar~~ → the dock** — done in #2, refined in #3. A bar
      of bookmarks into the canvas: tag a panel, click its chip to fly there.
      The panel never moves — this is navigation, not relocation — and the jump
      auto-zooms to a size that suits the content (a YouTube panel lands
      watchable, an audio player doesn't blow up to fill the screen). Chips are
      named after what they hold (video title / file name) and can be renamed.

      Landed *shared* rather than per-user, reversing the original plan: these
      read better as landmarks in a canvas both people are looking at than as
      private shortcuts — closer to Figma frames than browser bookmarks.
      Tagging and renaming sync; **dismissing is deliberately local**, so
      neither person can delete a bookmark out of the other's bar.

- [x] **One-time viewport handoff** — participant dock entries now support two
      explicit actions: request another participant's current view, or suggest
      yours to them. A suggestion is shown as an invitation and never moves the
      recipient until they accept it.
- [x] **~~"Snap to my screen"~~ — superseded by shared tags and handoff** — the original
      idea was to push my viewport onto the other person. Tagging turns out to
      be the better answer to the same need: it says *look at this* and pulses
      on their dock, and they travel when they're ready. A hard snap yanks
      someone's camera while they might be mid-brushstroke or mid-sentence,
      which in a shared canvas is closer to grabbing their mouse.

      Continuous movement is available separately through the explicit,
      mutually opted-into **"follow me" / presenting mode** — never by default.
- [ ] **Music mode** — a toggle that reopens the mic with voice processing
      disabled (echo cancellation, noise suppression and auto-gain all off) plus
      higher-bitrate stereo Opus. Browser defaults are tuned for speech and
      actively mangle instruments — noise suppression in particular treats
      sustained notes as noise. Small change, big difference for jam sessions.
- [x] **Mute toggles** — mic mute and camera off, implemented with track-level
      controls and video-track replacement where needed.
- [x] **Canvas recording** — a recorder panel composites the visible board,
      drawings, connectors and panels without opening the screen-share picker.
      Completed clips transfer directly to peers, persist in local IndexedDB and
      have synchronized selection and playback. Recording status remains visible
      at room level.

### Canvas tools

The tool rail was pen, eraser, eight colour swatches, three sizes and clear —
fifteen controls in a flat strip. The restructure came first so the rest could
be added without building a bad UI one good feature at a time.

- [x] **1 · Restructure the tool rail** — done (#7, refined in #10). Landed as a
      floating **island** rather than the fixed left rail first sketched: tools
      only, with colour, nib and size in a panel that appears for the selected
      tool and nothing else.

      Reworked once in use. The first version had pen, eraser *and* a colour
      swatch all opening the same panel — three buttons, one outcome. The swatch
      is gone; the pen button now carries the colour it will draw with, and the
      active tool shows a chevron so "tap again for options" is visible rather
      than folklore.

- [x] **2 · Brush engine — nibs, colour picker, metallics** — done (#9). All six
      nibs, four metallics, arbitrary colour, and the highlighter carries its own
      bright palette since highlighting in white does nothing.

      The seeding warning was real. Pencil and charcoal are seeded from their own
      coordinates; verified by redrawing after a zoom and getting an *identical*
      pixel count, which unseeded randomness could not produce. The fountain
      taper is baked in when drawn, since replay has no timing to derive speed
      from — measured at 22px slow against 10px fast.

      Metallics need width to read as metal: at size S a thin line is just a
      coloured line, which is a limitation rather than a bug.

- [x] **3 · Region tags** — done (#13). A selected area is an **asset** with a
      header, a tag button and a close button, rather than a bare frame, and
      tagging it is a separate act from creating it. Extends the existing point
      tags with optional bounds instead of adding a rival concept: no bounds is
      the point flag unchanged; bounds means it frames its content and zooms to
      fit rather than creeping closer each visit.

      ⚠️ Tags travel as **viewport fractions**, not world pixels. Sending pixels
      made the receiver scale them a second time and threw its canvas a million
      pixels away, taking both video feeds with it. Test positional features with
      the two peers at *different* window sizes — identical sizes hide this
      entirely.

- [x] **4 · Sticky notes** — done (#6). Text, chord and tab faces in one panel,
      each keeping its own content so switching never discards anything.

- [x] **5 · Music stickies** — chord diagrams and guitar tab done (#6), with
      several chord diagrams per note (#16). **Manuscript paper is still open** —
      a note pre-printed with blank staves to handwrite on, which is the cheapest
      of the three and possibly the most useful. ABC notation stays parked.

- [x] **6 · Shapes and connectors** — rectangle, ellipse, line and arrow tools,
      with Shift-constrained proportions and angles. Panel connectors store
      stable widget ids rather than fixed endpoints, so they remain attached
      through dragging, resizing, zooming, persistence and room handoff.

- [x] **7 · Images — upload, drop and paste** — custom image upload, drag-drop
      and clipboard screenshots now create resizable panels. Large images are
      bounded and compressed before using the existing chunked-transfer path.
      Emoji stickers remain a separate future enhancement.

- [x] **8 · Laser pointer** — a trail that fades after about a second and is
      never stored. For "look, *here*" without permanently marking the board.
      Fully independent of everything else.

- [ ] **9 · Eyedropper and an explicit pan/select tool** — pick a colour off the
      canvas; and a real cursor-mode button, since space-to-pan is undiscoverable
      and has no touch equivalent.

- [ ] **10 · Metronome** — a shared, synced click track. Not a toolbar tool but a
      panel like YouTube and audio.

> **Worth noting the direction.** A metronome, guitar tab, chord diagrams, the
> audio player and the video call together stop being a watch-party feature set
> and start being a **remote jamming tool**. That may be worth deciding on
> deliberately rather than arriving at — it would change what's worth building
> next.

### Additional suggestions

From a read-through of the current code — a mix of gaps, quick wins and one
outright bug.

- [x] **Fix: multiple YouTube panels cross-sync** — playback messages now carry
      the panel id, so independently spawned players ignore one another's
      commands.
- [x] **Join without camera** — done. A `getUserMedia` failure now substitutes an
      empty `MediaStream` and joins receive-only rather than showing a blocking
      error screen.
- [x] **Late-join / rejoin state handoff (P2P)** — a joining participant requests
      the host's current snapshot, including drawings, panels, notes, code, dock
      bookmarks, tags and viewport. Media is transferred separately in chunks.
- [x] **Live cursors** — show the other person's cursor on the canvas. Cheap to
      sync, and the natural companion to shared tags: a tag says "this thing
      matters", a cursor says "this bit, right here, right now".
- [x] **Late-join / rejoin state handoff (P2P)** — the host sends the current
      versioned snapshot when a participant joins or reconnects, followed by
      locally available media through the existing chunked-transfer path.
- [x] **Local room recovery** — versioned room state is saved in localStorage;
      audio, images and recorder clips are retained in IndexedDB and reattached
      when the same browser opens the room again.
- [x] **Room bundle backup and handoff** — export/import carries drawings,
      shapes, connectors, notes, code, widgets, layout, dock entries, labels and
      media metadata. Media bytes intentionally remain local.
- [x] **Canvas-recorder panels** — capture the composed board with `MediaRecorder`, keep
      multiple local clips, transfer them in chunks and synchronize selection,
      play, pause and seek without requesting display-capture permission.
- [x] **Image drop** — dropped, pasted and uploaded images are resized when
      necessary, streamed in chunks and persisted locally with their panel.
- [ ] **Screen share (live)** — `getDisplayMedia` as an additional live panel,
      streamed the way video/audio already are. Distinct from the screen
      *recorder* widget below, which captures to a file rather than streaming.
- [ ] **Whiteboard undo** — the only recovery today is clear-everything. The
      stroke list is already held in memory, so undo-last-stroke is feasible.
      **Needs a decision first:** on a shared board, does undo remove *your* last
      stroke or the *last stroke anyone made*? Per-user is almost certainly right
      — global undo lets one person erase the other's work — but that needs
      per-stroke ownership, which doesn't exist yet.
- [x] **Reconnect handling** — done. `usePeer` now recovers a dropped connection
      and re-establishes the room role rather than the status badge going quiet;
      camera/mic are properly rebuilt rather than left dangling.
- [x] **Synced audio playback** — done. Audio panels share play / pause / seek
      over the data channel (`audio-play`, `audio-pause`, `audio-seek`).
- [ ] **Longer room codes** — *still one word from 503, re-verified 15 Aug
      2026 (`src/utils/roomCode.ts` unchanged).* — currently one word from a
      503-word list, which is guessable. Matters more now than when this was
      written: Summon (#31) actively encourages sharing the raw link, and
      boards now persist (see below), so a guessed code reaches saved content,
      not just an empty live session.
- [x] **Mute toggles** — done. Local video panel carries mic/camera controls
      (`microphoneEnabled`, `cameraEnabled`, `toggleMicrophone`, `toggleCamera`
      in `Session.tsx`), track-level as originally scoped.
- [x] **TURN server** — done (moved from Infrastructure below). `usePeer.ts`
      adds a TURN entry to the ICE server list when `VITE_TURN_URLS` /
      `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` are set, alongside five STUN
      servers. Config-only from here — whether a TURN provider is actually
      configured in the deployed env is outside what the code can confirm.
- [x] **Sync z-order for spawned panels** — done (#8). Fixing it turned up a
      worse sibling: the two peers' z counters drifted apart, so a panel you
      spawned could land *underneath* one the other person had raised and be
      completely unclickable. Both fixed together.

### Also landed, unplanned

Things that came out of using the app rather than from this list.

- [x] **The dock** — shared bookmarks with rename, per-content-type auto-zoom on
      jump, and a **ping** to make a bookmark pulse on the other person's screen
      (#2, #3, #12). Tagging and renaming are shared; dismissing is local, so
      neither person can clear the other's bar.
- [x] **Paste onto the canvas** (#14) — text becomes canvas text, a YouTube link
      becomes a player, any other link becomes a browser panel, and clipboard
      images or screenshots become image panels.
- [x] **Chunked file transfer** (#15) — replaces base64-ing a whole file into one
      message. This is the groundwork images, stickers and image paste all need.
      Verified by sha256 on a 12MB file across a real connection.
- [x] **Full-size tag handles when zoomed out** (#17) — below 45% zoom a panel
      header is ~9px tall and untaggable, which left anything untagged
      unreachable. Untagged panels now carry a counter-scaled handle.
- [x] **Summon** — invite someone into the room via their own messaging app,
      no login (#31). `navigator.share` on touch devices, an explicit
      Message/WhatsApp/Email/copy-link menu on desktop (desktop Safari's own
      share sheet offers Notes and Reminders, not people).
- [x] **PWA install icon + manifest** (#29).
- [x] **Movable canvas text, with synced position** — canvas text (freetype,
      above) can now be dragged after creation, not just placed once.
- [x] **Local session persistence + refresh/reload survival** — verified in
      code 15 Aug 2026 (`roomPersistence.ts`): the whole board (panels,
      drawings, tags, dock, canvas viewport) is saved to `localStorage` per
      room code, uploaded audio/recordings to IndexedDB, and restored on
      reopening the same room in the same browser. This is **local-only** —
      see the Phase 2 note below for what it doesn't cover.
- [x] **One-shot view suggestion** — double-click a participant to jump to
      their current viewport (`view-request`/`view-response`); a
      **"suggest my view"** action sends a card the other person can accept or
      dismiss (`view-suggestion`). Verified in code 15 Aug 2026. This is a
      one-time jump; the separately shipped **"Follow me"** presentation mode
      provides continuous, explicitly accepted viewport following.
- [x] **Code widgets** (`CodeWidget.tsx`) — a canvas panel for sharing code,
      spawned automatically when code is pasted onto the canvas or into a
      sticky note, with syntax highlighting and formatting for JS/TS/JSON/
      HTML/CSS/SQL/Python (Python via lazily-loaded Ruff WASM).
- [x] **Canvas recorder widget** (`ScreenRecorderWidget.tsx`) — record/pause/
      resume/stop the visible canvas composition, shared with the
      peer over the existing chunked transfer, synced playback/scrub, local
      download, and no browser screen-share prompt.
- [x] **Mic/camera track lifecycle fix** — turning the camera off now actually
      releases the physical device instead of just disabling the track.
- [x] **Mobile widget menu** — a hamburger menu for spawning widgets on small
      screens, alongside the summon-prompt-vs-tool-island positioning fix.

---

## Phase 2 — persistence

The motivation: coming back to a board the next day and finding your work still
there. Media and live sync stay peer-to-peer; the database only holds the
durable record, written in the background.

- [x] Local browser persistence for room snapshots and media
- [ ] Optional cloud database setup
- [x] Export and import a versioned room bundle containing the shared board,
      widgets, layout, navigation and media metadata without uploading anything
- [x] Save whiteboard content, connectors and panel layout per room; hydrate on join
- [x] Persist dock bookmarks with the board — named landmarks are exactly the
      kind of thing you'd expect to still be there tomorrow, and they double as
      a table of contents for a returning session
- [x] Rejoin a room after a reload in the same browser
- [ ] Rejoin a saved room from a fresh browser when no participant is online
- [ ] Revisit the landing-page copy — "No data leaves your browser" stops being
      true once boards are saved, and shouldn't quietly become inaccurate
- [ ] Room access model — guessable codes are a much bigger deal once a code
      opens a *saved* board rather than an empty live session. See "Longer room
      codes" above, which is now overdue independent of Phase 2.

---

## Later / bigger jobs

- [x] **Up to four participants** — implemented as a relayed P2P mesh with
      stable per-peer video panels and a clear room-full state. Going beyond
      four or five people would make an SFU a more appropriate architecture.
- [ ] **Text chat panel** — for links and anything else spoken words lose.
- [x] **"Follow me" / presenting mode** — implemented as an explicit invitation:
      each participant chooses whether to follow, receives live pan and zoom
      updates after accepting, and retains an always-visible stop control.

---

## New feature candidates

These are suggestions, not commitments. The first three form a sensible next
sequence: presence, safe editing, then richer canvas content.

### Recommended next

- [x] **Live cursors and laser pointers** — give each participant a named,
      coloured cursor plus an optional trail that fades after about a second.
      Cursor updates should be throttled and never persisted.
- [ ] **Per-user undo and redo** — undo only the initiating participant's last
      drawing, text or panel action. This requires stable action ownership and
      avoids global undo erasing somebody else's work.
- [x] **Image and screenshot panels** — accept paste, drag-drop and upload;
      resize and compress large images before sending them through the existing
      chunked-transfer path.

### Shared-session tools

- [x] **Follow / presentation mode** — invite participants to follow a
      presenter's viewport, with explicit acceptance and an always-visible way
      to stop following.
- [ ] **Agenda and dock sequence** — order dock landmarks into a session path
      with previous/next controls for lessons, workshops and reviews.
- [ ] **Comments on objects and regions** — threaded, resolvable comments with
      unread indicators attached to panels or bounded canvas tags.
- [ ] **Shared timer and metronome widgets** — synchronize against a future
      wall-clock start time so countdowns and beats begin together.
- [ ] **Live screen-share panel** — publish `getDisplayMedia()` as a participant
      stream in a movable panel, distinct from capturing a recording.

### Canvas and portability

- [x] **Shapes and connectors** — rectangles, ellipses, lines, arrows and
      connectors that remain attached when linked panels move.
- [ ] **Room templates** — seed layouts for a watch party, pair-programming
      session, music lesson, study session or workshop.
- [x] **Export and import a room bundle** — download a portable snapshot with
      notes, code, layout and media metadata, then restore it in another browser.
- [ ] **Room security controls** — multi-word codes first, followed by optional
      passwords, waiting rooms and host-controlled admission before cloud
      persistence makes rooms accessible without a live participant.
