# watchtogether — roadmap

Working document, not a commitment — the ordering is open and items get rewritten
as we learn things from building them. Ticked items link to where they landed.

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

- [ ] **Free-type text on the canvas** — a text tool alongside pen/eraser. Text
      as movable, editable canvas objects, synced like strokes and panels.
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

- [x] **~~"Snap to my screen"~~ — superseded by shared tags** — the original
      idea was to push my viewport onto the other person. Tagging turns out to
      be the better answer to the same need: it says *look at this* and pulses
      on their dock, and they travel when they're ready. A hard snap yanks
      someone's camera while they might be mid-brushstroke or mid-sentence,
      which in a shared canvas is closer to grabbing their mouse.

      A true snap is still worth having eventually, but only as an explicit,
      mutually opted-into **"follow me" / presenting mode** — never the default.
      Moved to *Later* below.
- [ ] **Music mode** — a toggle that reopens the mic with voice processing
      disabled (echo cancellation, noise suppression and auto-gain all off) plus
      higher-bitrate stereo Opus. Browser defaults are tuned for speech and
      actively mangle instruments — noise suppression in particular treats
      sustained notes as noise. Small change, big difference for jam sessions.
- [ ] **Mute toggles** — mic mute and camera off. There are no such buttons
      today. Track-level `enabled = false`, so no renegotiation needed.
- [ ] **Session recording** — recorded locally via `MediaRecorder`, so it stays
      fully P2P with no server involved. Two tiers:
      - *Audio-only* (suggested first): mix local + remote audio through Web
        Audio into one downloadable file. Robust, small, and exactly what a
        jam session wants.
      - *Full session video* is harder — the canvas and panels can't be captured
        from the DOM directly, so the realistic route is tab capture via
        `getDisplayMedia`, which is clunkier UX.
      - Either way, the other person should always know: a visible recording
        indicator on both sides, synced over the data channel.

### Canvas tools

The tool rail is currently pen, eraser, eight colour swatches, three sizes and
clear — about fifteen controls in a flat strip. Everything below roughly triples
what it holds, so the restructure comes first or we build a bad UI one good
feature at a time. Items are grouped the way they'd ship: one push each.

- [ ] **1 · Restructure the tool rail** — grouped tools with fly-out panels
      instead of a flat list. Pen opens its nib choice, shapes open shape choice,
      the eight swatches collapse to a single swatch showing the current colour.
      Deliberately no new features in this one, so it can be judged as a UI
      change on its own.

      Decided while mocking it up: the rail becomes **fixed to the left edge**
      rather than a floating draggable panel. On narrow screens it narrows and
      overflows into a "more" button, and fly-outs become a bottom sheet — which
      has to sit *above* the dock, since both want the bottom of the screen.

- [ ] **2 · Brush engine — nibs, colour picker, metallics** — one push because
      all three touch the same stroke rendering and the same sync message;
      splitting them guarantees conflicts.
      - Nibs: ballpoint (today's behaviour), fountain pen (width from stroke
        speed), pencil, charcoal, highlighter, neon.
      - **Highlighter carries its own colour set** rather than the current pen
        colour — highlighting in white is useless.
      - Colour: one swatch opening a picker with the standard palette, recents,
        and an arbitrary-colour input.
      - Metallics (gold, silver, copper, bronze) rendered as a gradient
        *perpendicular* to each segment — dark edge, bright core, dark edge — so
        they read as metal rather than as flat yellow. Sync as a token like
        `metal:gold`, the same shape as the existing `__eraser__` sentinel.

      ⚠️ Pencil and charcoal texture **must be seeded from stroke coordinates**.
      Strokes are re-rendered on every pan and zoom, so unseeded randomness makes
      the grain reshuffle and the whole board visibly crawl.

- [ ] **3 · Region tags** — extends the position tags that already exist. A
      long-press currently drops a point tag; this adds *drag a box* to tag an
      area. Because a region has bounds it can zoom-to-fit on jump (a point can
      only preserve the current scale) and it draws a frame around what was
      tagged. The motivating case is handwriting: strokes aren't panels, so a
      region is the only way to bookmark something you drew.

- [ ] **4 · Sticky notes** — text as canvas objects: draggable, resizable,
      colour choice, synced. Reuses `DraggablePanel` and the spawn machinery, and
      satisfies the "free-type text" item above. Best value-per-effort here.

- [ ] **5 · Music stickies** — variants of the sticky note, aimed at the way this
      app actually gets used.
      - **Chord diagrams** — the six-by-five grid with dots for finger positions.
        Trivial SVG, and the most direct way to say "play *this*" remotely.
      - **Guitar tab** — a monospace text area with `e B G D A E` down the side.
        No library needed.
      - **Manuscript paper** — a sticky pre-printed with blank staves (or blank
        tab) that you **handwrite on with the existing pen**. Cheapest of the
        three and possibly the most used: writing a melody by hand mid-session is
        faster than typing notation, and the pen is already there.
      - *Parked:* full standard notation via `abcjs`. Technically fine, but it
        means authoring ABC text (`|:G2AB c2BA:|`) live — a beautiful feature
        nobody would touch unless they already read and write ABC.

- [ ] **6 · Shapes** — rectangle, ellipse, line, arrow, with shift-constrain.
      Arrows especially: pointing at things is the commonest annotation need and
      freehand arrows always look scrappy. Depends on 1.

- [ ] **7 · Images — stickers, drop and paste** — emoji stickers, custom image
      upload, drag-drop, and ⌘V from the clipboard. One push because they share
      an ingest path, and that path needs building: downscale to ~512px and
      re-encode before sending, since the current base64-over-data-channel
      transfer will choke on a phone photo. Also closes the image-drop item.

- [ ] **8 · Laser pointer** — a trail that fades after about a second and is
      never stored. For "look, *here*" mid-conversation without permanently
      marking the board. Fully independent of everything else.

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

- [ ] **Fix: multiple YouTube panels cross-sync** — playback messages
      (`load`/`play`/`pause`/`seek`) carry no panel id, so with two YouTube
      players open, both react to every message. Panel *layout* messages have
      ids; playback ones don't. Well-scoped first PR.
- [x] **Join without camera** — done. A `getUserMedia` failure now substitutes an
      empty `MediaStream` and joins receive-only rather than showing a blocking
      error screen.
- [ ] **Late-join / rejoin state handoff (P2P)** — *now the most valuable item
      on this list.* When a guest connects or reconnects, the host re-sends
      current state over the data channel. Needs no database, and it builds the
      "serialise a session" machinery that Phase 2 then reuses.

      Three features now depend on it, which is why it's worth doing as one job:
      whiteboard strokes, spawned panels and the loaded video are all invisible
      to a late joiner — and so are dock bookmarks, since tags are only sent at
      the moment of tagging. Join a session five minutes late and you get a
      blank canvas and an empty bar.
- [ ] **Live cursors** — show the other person's cursor on the canvas. Cheap to
      sync, and the natural companion to shared tags: a tag says "this thing
      matters", a cursor says "this bit, right here, right now".
- [ ] **Image drop** — drag an image onto the canvas and both sides see it, same
      mechanism as the existing audio-file drop. Wants a file-size guard: the
      current base64-in-one-message transfer will struggle on large files.
- [ ] **Screen share** — `getDisplayMedia` as an additional panel. Natural fit
      for a watch-together app and stays fully P2P.
- [ ] **Whiteboard undo** — the only recovery today is clear-everything. The
      stroke list is already held in memory, so undo-last-stroke is feasible.
      **Needs a decision first:** on a shared board, does undo remove *your* last
      stroke or the *last stroke anyone made*? Per-user is almost certainly right
      — global undo lets one person erase the other's work — but that needs
      per-stroke ownership, which doesn't exist yet.
- [x] **Reconnect handling** — done. `usePeer` now recovers a dropped connection
      and re-establishes the room role rather than the status badge going quiet.
- [x] **Synced audio playback** — done. Audio panels share play / pause / seek
      over the data channel (`audio-play`, `audio-pause`, `audio-seek`).
- [ ] **Longer room codes** — currently one word from a 503-word list, which is
      guessable. Two or three words is cheap to do now and matters much more
      once boards persist (see Phase 2).
- [ ] **Sync z-order for spawned panels** — bring-to-front updates z locally but
      never syncs it. The fixed video panels do sync. (Still open as of the dock
      work — `makeDynamicPanelHandlers`.)

### Infrastructure

- [ ] **TURN server** — without one, peers behind strict NATs (a lot of mobile
      data, some corporate wifi) can't connect at all, and there's no
      client-side fix. The one reliability gap P2P can't close on its own.
      Needs a hosted component, so it's a cost decision rather than a code one.

---

## Phase 2 — persistence

The motivation: coming back to a board the next day and finding your work still
there. Media and live sync stay peer-to-peer; the database only holds the
durable record, written in the background.

- [ ] Database setup (Supabase — free tier is plenty)
- [ ] Save whiteboard strokes and panel layout per room; hydrate on join
- [ ] Persist dock bookmarks with the board — named landmarks are exactly the
      kind of thing you'd expect to still be there tomorrow, and they double as
      a table of contents for a returning session
- [ ] Rejoin a room from a fresh browser or after a reload
- [ ] Revisit the landing-page copy — "No data leaves your browser" stops being
      true once boards are saved, and shouldn't quietly become inaccurate
- [ ] Room access model — guessable codes are a much bigger deal once a code
      opens a *saved* board rather than an empty live session

---

## Later / bigger jobs

- [ ] **Third participant** — can stay P2P; a three-way mesh is fine on
      bandwidth. The real cost is code, not infrastructure: `usePeer` and the
      session state are hardwired to exactly two peers, and the local/remote
      panel swap only works for two. Beyond four or five people a mesh stops
      scaling and would need a media server (SFU) — a different project.
- [ ] **Text chat panel** — for links and anything else spoken words lose.
- [ ] **"Follow me" / presenting mode** — a genuine viewport snap, but explicit
      and mutually opted into: I present, you follow, and either of us can stop.
      Distinct from shared tags, which invite rather than compel. Only worth
      building if tagging turns out not to cover the "look at this" need in
      practice.
- [ ] **Third participant and the dock** — dock ids are per-panel, so the bar
      itself generalises to more peers without much thought. The `local`/`remote`
      id swap does not: it assumes exactly two people. Whatever replaces that
      swap for N peers has to fix tagging a video panel at the same time.
