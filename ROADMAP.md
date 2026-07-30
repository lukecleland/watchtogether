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
