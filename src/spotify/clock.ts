// A local playback clock kept in step with Spotify.
//
// Spotify is polled every few seconds; between polls the position is
// extrapolated from performance.now(). Each poll's position is assumed to be
// measured halfway through the request. Small disagreements are mostly
// network jitter, so they're blended in gradually (more for fast requests);
// big ones (seek, track change, pause/resume) snap immediately.

export interface ClockSample {
  trackId: string
  progressMs: number
  durationMs: number
  isPlaying: boolean
  /** performance.now() when the position was (estimated to be) measured. */
  sampledAt: number
  rttMs: number
}

export type SyncResult = 'jump' | 'adjust'

/** Disagreements bigger than this are treated as a seek rather than jitter. */
export const JUMP_MS = 1500

export class PlaybackClock {
  trackId = ''
  durationMs = 0
  playing = false
  /** Prediction error at the last sync, in ms (positive = Spotify was ahead of us). */
  lastErrorMs = 0
  lastRttMs = 0
  lastSyncAt = 0
  private anchorPos = 0
  private anchorAt = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Position in the track in ms, as Spotify would report it right now. */
  position(at = this.now()): number {
    const p = this.anchorPos + (this.playing ? at - this.anchorAt : 0)
    const capped = this.durationMs ? Math.min(p, this.durationMs) : p
    return Math.max(0, capped)
  }

  get hasTrack() {
    return this.trackId !== ''
  }

  sync(s: ClockSample): SyncResult {
    const predicted = this.position(s.sampledAt)
    const err = s.progressMs - predicted
    const continuous = s.trackId === this.trackId && this.playing && s.isPlaying && Math.abs(err) <= JUMP_MS

    this.durationMs = s.durationMs
    this.playing = s.isPlaying
    this.lastErrorMs = err
    this.lastRttMs = s.rttMs
    this.lastSyncAt = this.now()

    if (!continuous) {
      this.trackId = s.trackId
      this.anchorPos = s.progressMs
      this.anchorAt = s.sampledAt
      return 'jump'
    }
    const trust = s.rttMs < 250 ? 0.5 : s.rttMs < 600 ? 0.25 : 0.1
    this.anchorPos = predicted + err * trust
    this.anchorAt = s.sampledAt
    return 'adjust'
  }

  /** Optimistic local seek/pause, e.g. for the demo clock. */
  set(trackId: string, positionMs: number, playing: boolean, durationMs = this.durationMs) {
    this.trackId = trackId
    this.durationMs = durationMs
    this.anchorPos = positionMs
    this.anchorAt = this.now()
    this.playing = playing
  }

  clear() {
    this.trackId = ''
    this.playing = false
    this.anchorPos = 0
    this.durationMs = 0
  }
}
