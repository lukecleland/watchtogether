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

- [ ] **6 · Shapes** — rectangle, ellipse, line, arrow, with shift-constrain.
      Arrows especially: pointing at things is the commonest annotation need and
      freehand arrows always look scrappy.

- [ ] **7 · Images — stickers, drop and paste** — emoji stickers, custom image
      upload, drag-drop, and ⌘V. **The transfer work this was blocked on is now
      done** (#15), so this is unblocked: it needs image rendering on the canvas
      and downscaling before send, not a new transfer mechanism.

- [ ] **8 · Laser pointer** — a trail that fades after about a second and is
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

- [ ] **Fix: multiple YouTube panels cross-sync** — *still open, re-verified 30
      July 2026: `load`/`play`/`pause`/`seek` in `SyncMessage` carry no id.* — playback messages
      (`load`/`play`/`pause`/`seek`) carry no panel id, so with two YouTube
      players open, both react to every message. Panel *layout* messages have
      ids; playback ones don't. Well-scoped first PR.
- [x] **Join without camera** — done. A `getUserMedia` failure now substitutes an
      empty `MediaStream` and joins receive-only rather than showing a blocking
      error screen.
- [ ] **Late-join / rejoin state handoff (P2P)** — *still the most valuable item
      on this list, and more so than when it was written.* When a guest connects
      or reconnects, the host re-sends current state over the data channel. Needs
      no database, and it builds the "serialise a session" machinery Phase 2 then
      reuses to hydrate a saved board.

      It now covers six kinds of content, not three: whiteboard strokes, canvas
      text, spawned panels, the loaded video, dock bookmarks and area tags are
      all invisible to a late joiner. Join five minutes late and you get a blank
      canvas and an empty bar.
- [ ] **Live cursors** — show the other person's cursor on the canvas. Cheap to
      sync, and the natural companion to shared tags: a tag says "this thing
      matters", a cursor says "this bit, right here, right now".
- [ ] **Image drop** — *unblocked by the chunked transfer in #15; needs image
      rendering on the canvas and downscaling before send.* — drag an image onto the canvas and both sides see it, same
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
- [ ] **Longer room codes** — *still one word from 503, re-verified 30 July.* — currently one word from a 503-word list, which is
      guessable. Two or three words is cheap to do now and matters much more
      once boards persist (see Phase 2).
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
      becomes a player, any other link becomes a browser panel. Images
      deliberately excluded until there's image support.
- [x] **Chunked file transfer** (#15) — replaces base64-ing a whole file into one
      message. This is the groundwork images, stickers and image paste all need.
      Verified by sha256 on a 12MB file across a real connection.
- [x] **Full-size tag handles when zoomed out** (#17) — below 45% zoom a panel
      header is ~9px tall and untaggable, which left anything untagged
      unreachable. Untagged panels now carry a counter-scaled handle.

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
