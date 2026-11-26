# ChordGlass

Guitar chords, key and tuning for whatever is playing on Spotify, shown on Even Realities G2 glasses in time with the music. You control it with the R1 ring or the temple touchpads.

It's an Even Hub plugin: a web app that runs inside the Even Realities app on your iPhone and draws to the glasses over Bluetooth.

```
Spotify (/me/player/currently-playing, every ~3 s)
   └─> local playback clock (extrapolated between polls, jitter smoothed)
          └─> chord chart for that track ID
                 1. your own chart (typed on the phone, or timed by tapping along)
                 2. Chordonomicon: untimed progressions for ~430k Spotify tracks
          └─> glasses: big current chord, next chord + countdown, section, key · tuning · capo
```

## Status (v0.1)

Works in the Even Hub simulator and a desktop browser: demo song, timed and untimed charts, ring and touchpad gestures, the hold menu, record mode, and the text-only fallback. It has **not been tried on real G2 hardware yet**. The first things to check there are listed under [Testing on the glasses](#testing-on-the-glasses).

Honest limits:

- **Chordonomicon charts have no timing.** They give you the chords and sections of a song. You step through the sections with swipes, or time the chart once by tapping along (see [Record mode](#record-mode)). After that it plays in sync.
- **Matching is by exact Spotify track ID.** The same song often has several IDs (single, album, remaster, regional copies). If a song isn't found, try another version, or type the chords on the phone.
- **The key is a guess** worked out from the chords. A `?` means it's unsure. A key you write in the chart always wins.
- **Tuning and capo come only from charts you write.** Chordonomicon doesn't include them, so the app shows "Standard (assumed)".
- **Sync** is as good as Spotify's reported position, roughly ±200 ms. Swipe up or down to nudge it. Bluetooth headphones add their own delay.
- **Spotify Development Mode** allows 5 users per app and requires the app owner to have Premium. That's why every user brings their own Client ID.

## Quick start (no glasses, no Spotify)

```bash
npm install
npm run fetch-model             # ChordMini chord model into public/models (for listening)
npm run dev                     # http://127.0.0.1:5173/?demo  (browser preview of the glasses)
npm run sim                     # official Even Hub simulator on the demo song
```

### Chord index (Chordonomicon)

Download `chordonomicon_v2.csv` (264 MB) from <https://huggingface.co/datasets/ailsntua/Chordonomicon> and build the shards:

```bash
npm run index:chordonomicon -- path/to/chordonomicon_v2.csv     # writes public/cn/ (2048 files, 138 MB)
```

`npm run dev` serves the shards, and so does the GitHub Pages build, which runs this step itself. To see a real chart without Spotify, open `http://127.0.0.1:5173/?demo=<spotify track id>`, for example `?demo=2ffJZ2r8HxI5DHcmf3BO6c`.

## Spotify setup (once)

This build uses the ChordGlass Spotify app (Client ID `f29d72ced8454a9c98bd5c2f1602a517`, set in `src/spotify/auth.ts`). A Client ID is public; with PKCE there is no secret. In that app's dashboard:

1. Under **Redirect URIs**, add both of these exactly:
   - `http://127.0.0.1:5173/` (for laptop development; Spotify rejects `localhost`)
   - `https://rohitpugazh.github.io/chordglass/` (the hosted build)
2. Under **User Management**, add every Spotify account that will sign in (up to 5 in Development Mode).

To use a different Spotify app, create one at <https://developer.spotify.com/dashboard> (tick **Web API**; the owner needs Premium), register the same redirect URIs, and paste its Client ID under **Using your own Spotify app** on the phone page.

## Running on the glasses

**A. Hosted on GitHub Pages (recommended)**

The app is live at <https://rohitpugazh.github.io/chordglass/>. Every push to `main` rebuilds the app and the chord index (`.github/workflows/pages.yml`).

1. Run `npx evenhub qr --url https://rohitpugazh.github.io/chordglass/` and scan the code in the Even app (Even Hub → developer QR).
2. On the phone page, tap **Connect Spotify**. Use Spotify's email login, because Google, Apple and Facebook block sign-in inside embedded web views.

**B. LAN dev server (fast iteration)**

1. Run `npm run dev`, open `http://127.0.0.1:5173/` on the laptop, and connect Spotify there.
2. Tap **Show sign-in key** and copy the key.
3. Run `npm run qr`, scan it with the phone, and paste the key under **Spotify → Sign-in key**. Sign-in can't run on a LAN `http://` address, which is why the key is needed.

**C. Private build (.ehpk)**

1. `app.json` already whitelists `https://rohitpugazh.github.io`, and `.env.production` points production builds at the hosted chord index.
2. Run `npm run pack` and upload `chordglass.ehpk` at hub.evenrealities.com. In the Even app, go to **Even Hub → Me → Apps → Private builds**. Sign in with a sign-in key.

## Listen to the music (auto-timing)

On the phone page under **Listen to the music**, choose **Glasses microphone**. You can also hold on the glasses and choose **Listen to the music**.

The app runs a chord-recognition model on your phone. That's ChordMini (ChordNet 2E1D, MIT), downloaded once: 17 MB of model plus a 15 MB runtime. The model listens to what the glasses mic hears, and the app uses that in two ways:

- **With a chart (Chordonomicon or yours, untimed):** the chart is lined up with the music. The app copes with sections the chord sheet only wrote once and with listening starting mid-song. It also notices when the recording is in a different key from the chart, for example a band tuned a half step down. The big chord is then marked "♪ in sync by listening" and the next chord arrives on time. When a song finishes after a good alignment, its timing is saved as your chart for that track.
- **Without a chart, or with a chart that doesn't match the music:** it shows the chord it hears, about a second behind the music.

Audio is analysed on the phone and never sent anywhere. The mic has to hear the music, so this won't work with headphones.

For development, `npm run loopback` streams whatever this computer plays as 16 kHz PCM, the glasses mic's format. Then open `http://127.0.0.1:5173/?audio=http://127.0.0.1:8765/pcm`.

## Controls

| Gesture (ring or temple) | Timed chart | Untimed chart | Record mode |
|---|---|---|---|
| Tap | Song info | Song info | Time the next chord |
| Swipe up | Chords 100 ms earlier | Previous section | Undo last tap |
| Swipe down | Chords 100 ms later | Next section | Skip this chord |
| Hold | Menu: record timings, transpose ±1, reset sync, song info, big chord on/off, reload | Menu | Menu: save, start over, discard |
| Double-tap | Exit (with confirmation) | Exit | Save and stop |

Swipe directions can be swapped on the phone page.

### Record mode

Turns an untimed chart into a timed one:

1. Hold, then choose **Record chord timings**.
2. Restart the song.
3. Tap the ring as each chord starts. Repeats of the same chord are skipped for you.
4. Double-tap to save.

The times are stored on the phone for that track, and from then on the chords follow the music.

## Chart format

You edit charts on the phone page under **Chords for this song**.

```
title: Example
artist: Somebody
key: G            # optional; guessed from the chords if missing
tuning: Eb        # Standard, Eb, Drop D, DADGAD, "D A D G B E", ...
capo: 2

[Intro]
0:00.0 G          # m:ss.s when the chord starts
0:02.5 D/F#
[Verse 1] 0:05.0
Em C G D x2       # untimed chords are spread evenly between timed ones
```

## Layout

| Path | What |
|---|---|
| `src/theory/` | chord parsing (standard and Chordonomicon spellings), key detection, tunings |
| `src/chart/` | chart format, timeline interpolation, Chordonomicon lookup |
| `src/spotify/` | PKCE sign-in and sign-in keys, the playback call, the sync clock |
| `src/glasses/` | renderer (fewest bridge calls, coalesced), big-chord image, font-safe text |
| `src/app/` | controller (state, polling, gestures, menu, record mode), page layouts, demo song |
| `src/phone/` | phone page: Spotify, live preview, chart editor, settings |
| `scripts/build_chordonomicon_index.py` | CSV → `public/cn/NNNN.json` shards (FNV-1a hash of the track ID) |
| `tests/` | `npm test`: theory, charts, clock, page layouts |

## Testing on the glasses

These are the things the simulator can't tell you:

- [ ] Spotify sign-in returns inside the Even app on iOS.
- [ ] The big-chord image (288×144) sends and looks sharp. If image sends fail twice, the app switches to text-only by itself.
- [ ] Chord changes land on the beat. Tune **Sync** on the phone page, or swipe while a song plays.
- [ ] The R1 ring delivers tap and swipes the same way the temple does.
- [ ] Polling survives the phone locking for a few minutes.

## Next steps

1. **Tuning and capo metadata** from tab sources, or from your own Guitar Pro files via alphaTab.
2. **Tabs.** The glasses font is proportional, so tab lines would be drawn as images.

## Credits

- Chord recognition: **ChordMini** ([ptnghia-j/ChordMini](https://github.com/ptnghia-j/ChordMini), MIT), using the ONNX export and CQT plan from [musetric/chordmini-onnx](https://huggingface.co/musetric/chordmini-onnx) (MIT). The CPU CQT follows musetric's `packages/cqt` (MIT). The model runs on [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT).
- Chord progressions: **Chordonomicon** (Kantarelis et al., 2024), [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Non-commercial use only, with attribution. The derived `cn/` shards keep that license.
- G2 platform notes: [nickustinov/even-g2-notes](https://github.com/nickustinov/even-g2-notes).
- Patterns learned from open G2 plugins: now-playing (PKCE in the Even WebView, sign-in keys), Riff, lyrics-glow, DisplayPlus Music and BoneGlimpse.
- Not affiliated with Spotify or Even Realities.
