# TODO

## Audio track switch (AC-3) — remaining issues

- Occasional freeze/unfreeze cycles after switching to AC-3.
- Sometimes the player does not enter the paused/buffering state (possibly
  another thread/worker keeps running).
- AC-3 switches are slower than MP3 (WASM decoder init + demux read:
  ~0.8–3.5 s vs ~0.1–0.3 s). The audio can start slightly before the video,
  and the video catches up (short fast-forward).
- Not fixed yet (deferred on purpose).

### Ideas

- Preload the E-AC-3/AC-3 WASM decoder at open time to cut the switch cost.
- Seamless switch: keep the old audio ring/worklet playing until the new
  track is primed, then swap at the same media time (avoids silence and
  audio-before-video).
- Add a two-audio-track fixture (flashes + beeps at 1/4/7 s) and an E2E
  scenario that switches at 2 s, then measures the A/V offset objectively.
- Investigate pause/stop propagation: ensure the render and presentation
  loops and the demux worker honor the paused state during a switch.

## Known limitations

- 4K60 H.264 decoded in software cannot run in real time: audio stays
  master and smooth, video is best-effort (frames dropped when needed).
  Hardware decoding or a lighter source is required for perfect 4K60.
- No GOP skipping for slow decoders: it starved audio and was unreliable.
