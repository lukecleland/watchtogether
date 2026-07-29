# watchtogether — roadmap

A proposal, not a plan — nothing here is committed to and the ordering is open to
change. Opened as a PR so it can be discussed before any of it gets built.

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
- [ ] **Pin items to a bar** — pin any panel or asset (a to-do list, say) to a
      fixed dock so it stays on screen instead of being somewhere out on the
      infinite canvas. Pinning is per-user — my dock isn't your dock.
- [ ] **"Snap to my screen"** — one click sends my current viewport (pan + zoom)
      to the other person so they see exactly what I'm looking at. Cheap to
      build: it's the canvas transform broadcast over the data channel. Could
      extend to a continuous "follow me" mode later.
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
- [ ] **Join without camera** — camera + mic is currently a hard requirement to
      enter a session. Allowing audio-only or view-only join is friendlier, and
      it makes the app testable without a webcam.
- [ ] **Late-join / rejoin state handoff (P2P)** — when a guest connects or
      reconnects, the host re-sends current state (strokes, spawned panels,
      loaded video) over the data channel. Needs no database, and it builds the
      "serialise a session" machinery that Phase 2 then reuses.
- [ ] **Live cursors** — show the other person's cursor on the canvas. Cheap to
      sync and makes "look at this" natural. Pairs well with snap-to-screen.
- [ ] **Image drop** — drag an image onto the canvas and both sides see it, same
      mechanism as the existing audio-file drop. Wants a file-size guard: the
      current base64-in-one-message transfer will struggle on large files.
- [ ] **Screen share** — `getDisplayMedia` as an additional panel. Natural fit
      for a watch-together app and stays fully P2P.
- [ ] **Whiteboard undo** — the only recovery today is clear-everything. The
      stroke list is already held in memory, so undo-last-stroke is feasible.
- [ ] **Reconnect handling** — auto-rejoin when a connection drops, instead of
      the status badge going quiet.
- [ ] **Longer room codes** — currently one word from a 503-word list, which is
      guessable. Two or three words is cheap to do now and matters much more
      once boards persist (see Phase 2).
- [ ] **Sync z-order for spawned panels** — bring-to-front updates z locally but
      never syncs it. The fixed video panels do sync.

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
