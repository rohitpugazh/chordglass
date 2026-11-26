// The app's state machine: follows Spotify, loads chords for each track,
// decides what the glasses show, and handles gestures and the hold menu.

import { AudioInputSource, EventSourceType, OsEventTypeList as Ev, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { getBridge, serial } from '../bridge'
import { isTimed, sections, type Chart } from '../chart/chart'
import { Screen, type Page } from '../glasses/screen'
import { NotSignedIn } from '../spotify/auth'
import { getPlayback, rateLimitedForMs, SpotifyError, type Playback } from '../spotify/api'
import { PlaybackClock } from '../spotify/clock'
import { findChart, hasUserChart, saveUserChart } from './charts'
import { Listening, startDevAudioStream } from './listening'
import { DEMO_ARTIST, DEMO_DURATION_MS, DEMO_TITLE, DEMO_TRACK_ID, demoChart } from './demo'
import { heardPage, infoPage, MENU, messagePage, recordPage, timedPage, untimedPage, type Song } from './pages'
import { onPrefsChange, prefs, savePrefs } from './prefs'
import { songInfo, type SongInfo } from './songinfo'

const debug = import.meta.env.DEV ? (...a: unknown[]) => console.debug('[app]', ...a) : () => {}

/** Human tap latency subtracted from recorded chord times. */
const TAP_REACTION_MS = 60
const LEAD_STEP_MS = 100
const FLASH_MS = 2500

type View = 'main' | 'info' | 'record'
type ChartState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; chart: Chart; info: SongInfo }

export interface AppSnapshot {
  signedIn: boolean
  problem: string
  track: { id: string; title: string; artists: string; durationMs: number } | null
  positionMs: number
  playing: boolean
  chart: ChartState
  demo: boolean
}

export interface PollSample {
  at: number
  trackId: string
  /** Spotify's position minus our extrapolated position, ms. */
  errMs: number
  rttMs: number
  result: 'jump' | 'adjust'
  playing: boolean
}

export interface TrackSeen {
  at: number
  id: string
  title: string
  artists: string
  durationMs: number
  /** "chordonomicon untimed, 122 chords, key E" / "missing" / "error: ..." */
  chart: string
}

export class App {
  /** What the app saw, for the phone page's diagnostics panel. */
  readonly diag = { polls: [] as PollSample[], tracks: [] as TrackSeen[], pollErrors: 0, lastError: '' }
  readonly screen = new Screen()
  readonly listening = new Listening(() => this.render())
  /** Dev aid: ?audio=<url> streams this computer's audio (scripts/loopback.py) in place of a mic. */
  private devAudioUrl = ''
  private stopDevAudio: (() => void) | null = null
  readonly clock = new PlaybackClock()
  private playback: Playback | null = null
  private chartState: ChartState = { status: 'none' }
  private view: View = 'main'
  private sectionIndex = 0
  /** For estimated timelines: how far the user has nudged it, in ms (a chord per swipe). */
  private estimateShiftMs = 0
  private problem = ''
  private signedIn = true
  private flash = ''
  private flashUntil = 0
  private foreground = true
  private failures = 0
  private pollTimer = 0
  private tickTimer = 0
  private changeTimer = 0
  private demo = false
  /** In demo mode, a Spotify track ID whose chords to show (dev aid: ?demo=<id>). */
  private demoTrack = ''
  private record: { chart: Chart; next: number; stamps: number[] } | null = null
  private lastGesture = { key: '', at: 0 }
  private listeners = new Set<() => void>()

  // ---------- lifecycle ----------

  async start(opts: { demo: boolean; demoTrack?: string; devAudioUrl?: string }) {
    this.demo = opts.demo
    this.demoTrack = opts.demoTrack ?? ''
    this.devAudioUrl = opts.devAudioUrl ?? ''
    onPrefsChange(changed => {
      if ('transpose' in changed || 'chordIndexUrl' in changed) void this.reloadChart(true)
      if ('listen' in changed) void (prefs.listen === 'off' && !this.devAudioUrl ? this.stopListening() : this.startListening())
      this.render()
    })
    if (prefs.listen !== 'off' || this.devAudioUrl) void this.startListening()
    const bridge = getBridge()
    if (bridge) await serial(async b => { b.onEvenHubEvent(e => this.onEvent(e)) })
    if (this.demo) this.startDemo()
    else await this.poll()
    this.tickTimer = window.setInterval(() => this.tick(), 250)
    this.render()
  }

  /** The phone page subscribes to show the same state. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): AppSnapshot {
    const p = this.playback
    return {
      signedIn: this.signedIn,
      problem: this.problem,
      track: p && p.trackId ? { id: p.trackId, title: p.title, artists: p.artists, durationMs: p.durationMs } : null,
      positionMs: this.clock.position(),
      playing: this.clock.playing,
      chart: this.chartState,
      demo: this.demo,
    }
  }

  setDemo(on: boolean) {
    if (on === this.demo) return
    this.demo = on
    this.view = 'main'
    this.record = null
    this.playback = null
    this.clock.clear()
    this.chartState = { status: 'none' }
    clearTimeout(this.pollTimer)
    if (on) this.startDemo()
    else void this.poll()
    this.render()
  }

  /** Re-check Spotify now, e.g. after signing in on the phone. */
  refreshNow() {
    if (!this.demo) void this.poll()
  }

  // ---------- Spotify ----------

  private schedulePoll(ms: number) {
    clearTimeout(this.pollTimer)
    this.pollTimer = window.setTimeout(() => void this.poll(), ms)
  }

  private nextPollDelay(): number {
    const limited = rateLimitedForMs()
    if (limited) return limited + 250
    if (this.failures) return Math.min(30_000, 3000 * 2 ** (this.failures - 1))
    if (!this.foreground) return 15_000
    if (!this.clock.playing) return 6000
    // Poll right after the track should end so the next one shows up promptly.
    const left = this.clock.durationMs - this.clock.position()
    return left > 0 && left < 3000 ? left + 400 : 3000
  }

  private async poll() {
    if (this.demo) return
    try {
      const p = await getPlayback()
      this.failures = 0
      this.signedIn = true
      this.problem = ''
      this.applyPlayback(p)
    } catch (e) {
      if (e instanceof NotSignedIn) {
        this.signedIn = false
        this.problem = e.message
      } else {
        this.failures++
        this.problem = e instanceof SpotifyError ? e.message : (e as Error).message
        this.diag.pollErrors++
        this.diag.lastError = this.problem
      }
      debug('poll failed', e)
    }
    this.render()
    if (!this.demo) this.schedulePoll(this.signedIn ? this.nextPollDelay() : 30_000)
  }

  private applyPlayback(p: Playback | null) {
    const before = this.playback?.trackId ?? ''
    this.playback = p
    if (!p || p.kind !== 'track' || !p.trackId) {
      if (before) this.chartState = { status: 'none' }
      this.clock.clear()
      return
    }
    const result = this.clock.sync({
      trackId: p.trackId, progressMs: p.progressMs, durationMs: p.durationMs,
      isPlaying: p.isPlaying, sampledAt: p.sampledAt, rttMs: p.rttMs,
    })
    this.diag.polls.push({
      at: Date.now(), trackId: p.trackId, errMs: Math.round(this.clock.lastErrorMs), rttMs: Math.round(p.rttMs), result, playing: p.isPlaying,
    })
    if (this.diag.polls.length > 300) this.diag.polls.shift()
    if (p.trackId !== before) {
      debug('track', p.title, p.trackId)
      this.diag.tracks.push({ at: Date.now(), id: p.trackId, title: p.title, artists: p.artists, durationMs: p.durationMs, chart: 'looking up' })
      if (this.diag.tracks.length > 100) this.diag.tracks.shift()
      this.view = this.view === 'info' ? 'info' : 'main'
      this.record = null
      this.sectionIndex = 0
      this.estimateShiftMs = 0
      void this.saveListenedTiming()
      this.listening.trackChanged()
      void this.reloadChart(false)
    } else if (result === 'jump') {
      debug('seek or resume')
      this.listening.clockJumped()
    }
  }

  private async reloadChart(keepChart: boolean) {
    const id = this.playback?.trackId
    if (this.demo && !this.demoTrack) {
      const chart = demoChart()
      this.chartState = { status: 'ready', chart, info: songInfo(chart, DEMO_DURATION_MS, prefs.transpose) }
      this.render()
      return
    }
    if (!id) return
    if (keepChart && this.chartState.status === 'ready') {
      const chart = this.chartState.chart
      this.chartState = { status: 'ready', chart, info: songInfo(chart, this.clock.durationMs, prefs.transpose) }
      this.render()
      return
    }
    this.chartState = { status: 'loading' }
    this.render()
    const p = this.playback
    const found = await findChart(id, this.demo ? undefined : { title: p?.title ?? '', artist: p?.mainArtist ?? '' })
    if (this.playback?.trackId !== id) return // track changed meanwhile
    if (found.status === 'found') {
      this.chartState = { status: 'ready', chart: found.chart, info: songInfo(found.chart, this.clock.durationMs, prefs.transpose) }
    } else if (found.status === 'missing') this.chartState = { status: 'missing' }
    else this.chartState = { status: 'error', message: found.message }
    const ready = this.chartState
    // Listening lines up charts that have no times of their own.
    this.listening.setChart(ready.status === 'ready' && !isTimed(ready.chart) ? ready.chart : null, this.clock.durationMs, `${id}|${ready.status}`)
    const seen = [...this.diag.tracks].reverse().find(t => t.id === id)
    if (seen) {
      const cs = this.chartState
      seen.chart = cs.status === 'ready'
        ? `${cs.chart.source}${found.status === 'found' && found.via ? ` (via other release ${found.via})` : ''} ${isTimed(cs.chart) ? 'timed' : 'untimed'}, ${cs.chart.events.length} chords, key ${cs.info.shapeKey}`
        : cs.status === 'error' ? `error: ${cs.message}` : cs.status
    }
    this.render()
  }

  /** The phone page saved a chart for the current track. */
  async chartEdited() {
    await this.reloadChart(false)
  }

  // ---------- demo ----------

  private startDemo() {
    const id = this.demoTrack || DEMO_TRACK_ID
    const duration = this.demoTrack ? 240_000 : DEMO_DURATION_MS
    this.playback = {
      kind: 'track', trackId: id, title: this.demoTrack ? `Track ${id}` : DEMO_TITLE, artists: this.demoTrack ? '' : DEMO_ARTIST, mainArtist: '',
      album: '', durationMs: duration, isPlaying: true, progressMs: 0, sampledAt: performance.now(), rttMs: 0,
    }
    this.clock.set(id, 0, true, duration)
    void this.reloadChart(false)
  }

  // ---------- rendering ----------

  private song(): Song {
    const p = this.playback
    return {
      title: p?.title ?? '',
      artist: p?.artists ?? '',
      positionMs: this.clock.position(),
      durationMs: this.clock.durationMs,
      playing: this.clock.playing,
    }
  }

  private currentFlash(): string {
    if (this.flash && Date.now() > this.flashUntil) this.flash = ''
    return this.flash
  }

  private showFlash(text: string) {
    this.flash = text
    this.flashUntil = Date.now() + FLASH_MS
    this.render()
  }

  /** The chart's timeline as heard, when listening has lined it up well enough to trust. */
  private alignedInfo(): SongInfo | null {
    const cs = this.chartState
    const a = this.listening.alignment
    if (cs.status !== 'ready' || isTimed(cs.chart) || !a || a.fit < 0.5 || this.listening.framesHeard < 50) return null
    const shift = this.listening.shift
    return { ...cs.info, timeline: a.timeline, estimated: false, mode: 'aligned', recordingShift: shift }
  }

  /** Listening is on but the chart is missing or doesn't match the music: show what's heard. */
  private heardReason(): string | null {
    if (this.listening.state !== 'on') return null
    const cs = this.chartState
    if (cs.status === 'missing' || cs.status === 'error') return 'no chart for this song'
    const a = this.listening.alignment
    if (cs.status === 'ready' && a && a.fit < 0.3 && this.listening.framesHeard > 150) return "chart doesn't match the music"
    // The band has departed from the sheet for the moment (a held chord, a different bridge): show what's heard until it locks back on.
    if (cs.status === 'ready' && a && a.fit >= 0.5 && a.recentFit < 0.45 && this.listening.framesHeard > 80 && this.listening.heard()) return 'off the sheet here'
    return null
  }

  private displayMs(): number {
    const cs = this.chartState
    const shift = cs.status === 'ready' && cs.info.estimated && !this.alignedInfo() ? this.estimateShiftMs : 0
    return this.clock.position() + prefs.leadMs + shift
  }

  private bigChord(): boolean {
    return prefs.bigChord && !this.screen.imagesBroken
  }

  page(): Page {
    const song = this.song()
    const flash = this.currentFlash()

    if (!this.demo) {
      if (!this.signedIn) {
        return messagePage(null, [
          'Spotify isn\'t connected.',
          '',
          'Open ChordGlass on your phone (Even app >',
          'Even Hub > ChordGlass) and connect Spotify.',
          '',
          'double-tap: exit',
        ])
      }
      if (!this.playback && this.problem) return messagePage(null, [clipLine(this.problem), '', 'Retrying...', 'tap: retry now'])
      if (!this.playback || this.playback.kind === 'unknown') {
        return messagePage(null, ['Nothing is playing on Spotify.', '', 'Start a song on any device and the', 'chords will appear here.', '', 'tap: check again'])
      }
      if (this.playback.kind !== 'track') {
        return messagePage(song, [this.playback.kind === 'ad' ? 'Advertisement' : 'Podcast episode', '', 'Chords appear when a song plays.'])
      }
    }

    const cs = this.chartState
    if (this.view === 'info') {
      return infoPage({
        song,
        info: cs.status === 'ready' ? cs.info : null,
        chart: cs.status === 'ready' ? cs.chart : null,
        leadMs: prefs.leadMs,
        syncErrorMs: this.clock.lastErrorMs,
        rttMs: this.clock.lastRttMs,
      })
    }
    if (cs.status === 'loading' || cs.status === 'none') return messagePage(song, ['Looking up chords...'])
    const heardReason = this.view === 'main' ? this.heardReason() : null
    if (heardReason) {
      const h = this.listening.heard()
      return heardPage({
        song, reason: heardReason, bigChord: this.bigChord(), flash,
        heard: h ? { label: h.label, ageMs: this.clock.position() - h.songMs } : null,
      })
    }
    if (cs.status === 'missing') {
      return messagePage(song, [
        'No chords found for this track.',
        '',
        'Add a chart on your phone: Even app >',
        'ChordGlass > Chords for this song.',
        '',
        flash || 'Spotify often has several IDs for one song;',
        'try the album version if this is a single.',
      ], [{ id: MENU.reload, label: 'Reload chords' }])
    }
    if (cs.status === 'error') {
      return messagePage(song, ['Couldn\'t load chords:', clipLine(cs.message), '', 'tap: try again'], [{ id: MENU.reload, label: 'Reload chords' }])
    }

    if (this.view === 'record' && this.record) {
      return recordPage({
        song, info: cs.info, chart: this.record.chart, next: this.record.next,
        timedCount: this.record.stamps.length, bigChord: this.bigChord(), flash,
      })
    }
    if (isTimed(cs.chart) || cs.info.estimated) {
      const info = this.alignedInfo() ?? cs.info
      const listening = this.listening.active
      const listenFlash = !flash && this.listening.state === 'on' && info.mode === 'estimated' ? 'listening to line the chords up...' : ''
      return timedPage({ song, info, leadMs: prefs.leadMs, displayMs: this.displayMs(), bigChord: this.bigChord(), flash: flash || listenFlash, listening })
    }
    return untimedPage({ song, info: cs.info, chart: cs.chart, sectionIndex: this.sectionIndex, flash })
  }

  render() {
    void this.screen.show(this.page())
    this.scheduleChordChange()
    this.listeners.forEach(fn => fn())
  }

  private tick() {
    // The demo song loops.
    if (this.demo && this.clock.position() >= this.clock.durationMs - 1) this.clock.set(this.clock.trackId, 0, true, this.clock.durationMs)
    this.render()
  }

  /** Wakes exactly when the next chord starts instead of waiting for the next tick. */
  private scheduleChordChange() {
    clearTimeout(this.changeTimer)
    const cs = this.chartState
    if (cs.status !== 'ready' || !this.clock.playing || this.view !== 'main') return
    const tl = cs.info.timeline
    if (!tl.length) return
    const now = this.displayMs()
    const next = tl.find(e => e.start > now)
    if (!next) return
    const wait = next.start - now
    if (wait < 250) this.changeTimer = window.setTimeout(() => this.render(), wait + 5)
  }

  // ---------- input ----------

  private onEvent(e: EvenHubEvent) {
    if (e.audioEvent) {
      const raw = e.audioEvent.audioPcm as unknown
      const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw as number[]) : null
      if (bytes) this.listening.audio(bytes, this.clock.position() - prefs.audioLatencyMs, this.clock.playing)
      return
    }
    if (e.menuItemClickEvent) {
      if (typeof e.menuItemClickEvent.itemID === 'number') void this.onMenu(e.menuItemClickEvent.itemID)
      return
    }
    const env = e.sysEvent ?? e.textEvent ?? e.listEvent
    if (!env) return
    // Protobuf drops zero values: a plain tap (CLICK_EVENT = 0) arrives without eventType.
    const type = env.eventType ?? Ev.CLICK_EVENT
    const source = e.sysEvent?.eventSource

    switch (type) {
      case Ev.FOREGROUND_ENTER_EVENT:
        this.foreground = true
        this.screen.invalidate()
        // The mic stops if the WebView was suspended; ask for it again.
        if (this.listening.active && !this.devAudioUrl) void this.armMic()
        if (!this.demo) void this.poll()
        else this.render()
        return
      case Ev.FOREGROUND_EXIT_EVENT:
        this.foreground = false
        return
      case Ev.SYSTEM_EXIT_EVENT:
        clearTimeout(this.pollTimer)
        clearInterval(this.tickTimer)
        return
      case Ev.ABNORMAL_EXIT_EVENT:
      case Ev.IMU_DATA_REPORT:
      case Ev.LONG_PRESS_EVENT:
      case Ev.LONG_PRESS_RELEASE_EVENT:
        // Long press opens the OS menu built from the page's menuObject.
        return
    }

    // The firmware can report one gesture twice in quick succession.
    const key = `${type}`
    const now = Date.now()
    const gap = type === Ev.SCROLL_TOP_EVENT || type === Ev.SCROLL_BOTTOM_EVENT ? 250 : 120
    if (this.lastGesture.key === key && now - this.lastGesture.at < gap) return
    this.lastGesture = { key, at: now }
    debug('gesture', type, source === EventSourceType.TOUCH_EVENT_FROM_RING ? 'ring' : 'glasses')

    if (type === Ev.CLICK_EVENT) this.onTap()
    else if (type === Ev.DOUBLE_CLICK_EVENT) this.onDoubleTap()
    else if (type === Ev.SCROLL_TOP_EVENT) this.onSwipe(prefs.swapSwipes ? 'down' : 'up')
    else if (type === Ev.SCROLL_BOTTOM_EVENT) this.onSwipe(prefs.swapSwipes ? 'up' : 'down')
  }

  /** Gestures from the phone page's buttons when there are no glasses (browser testing). */
  simulate(gesture: 'tap' | 'double' | 'up' | 'down' | number) {
    if (typeof gesture === 'number') return void this.onMenu(gesture)
    if (gesture === 'tap') this.onTap()
    else if (gesture === 'double') this.onDoubleTap()
    else this.onSwipe(prefs.swapSwipes ? (gesture === 'up' ? 'down' : 'up') : gesture)
  }

  /** The hold-menu items for the current screen, for the phone page's buttons. */
  menuItems() {
    return this.page().menu
  }

  private onTap() {
    if (this.view === 'record') return this.stampChord()
    if (this.view === 'info') { this.view = 'main'; return this.render() }
    const cs = this.chartState
    if (cs.status === 'error' || cs.status === 'missing') return void this.reloadChart(false)
    if (!this.demo && (!this.playback || this.problem)) return void this.poll()
    this.view = 'info'
    this.render()
  }

  private onDoubleTap() {
    if (this.view === 'record') return void this.finishRecording(true)
    if (this.view === 'info') { this.view = 'main'; return this.render() }
    // Root screen: Even Hub requires double-tap to open the exit dialog.
    void serial(b => b.shutDownPageContainer(1)).catch(() => {})
  }

  private onSwipe(dir: 'up' | 'down') {
    const cs = this.chartState
    if (this.view === 'record') return dir === 'up' ? this.undoStamp() : this.skipChord()
    if (this.view !== 'main' || cs.status !== 'ready') return
    if (cs.info.estimated && !this.alignedInfo()) {
      // The guess is off by whole chords, so move it a chord at a time.
      const tl = cs.info.timeline
      const now = this.displayMs()
      const i = tl.findIndex(e => e.start <= now && now < e.end)
      const step = i >= 0 ? tl[i].end - tl[i].start : (this.clock.durationMs || 1) / Math.max(1, tl.length)
      this.estimateShiftMs += dir === 'up' ? step : -step
      this.showFlash(dir === 'up' ? 'Jumped ahead one chord' : 'Went back one chord')
      return
    }
    if (isTimed(cs.chart)) {
      const leadMs = Math.max(-2000, Math.min(3000, prefs.leadMs + (dir === 'up' ? LEAD_STEP_MS : -LEAD_STEP_MS)))
      void savePrefs({ leadMs })
      this.showFlash(`Sync: chords ${leadMs} ms ${leadMs >= 0 ? 'early' : 'late'} (${dir === 'up' ? 'earlier' : 'later'})`)
      return
    }
    const count = sections(cs.chart).length
    this.sectionIndex = Math.max(0, Math.min(count - 1, this.sectionIndex + (dir === 'up' ? -1 : 1)))
    this.render()
  }

  private async onMenu(id: number) {
    debug('menu', id)
    switch (id) {
      case MENU.listen: return savePrefs({ listen: this.listening.active ? 'off' : 'glasses' }).then(() => this.showFlash(prefs.listen === 'off' ? 'Stopped listening' : 'Listening to the music...'))
      case MENU.record: return this.startRecording()
      case MENU.transposeUp: return savePrefs({ transpose: wrapTranspose(prefs.transpose + 1) }).then(() => this.showFlash(`Transposed ${fmtSigned(prefs.transpose)}`))
      case MENU.transposeDown: return savePrefs({ transpose: wrapTranspose(prefs.transpose - 1) }).then(() => this.showFlash(`Transposed ${fmtSigned(prefs.transpose)}`))
      case MENU.resetSync: return savePrefs({ leadMs: 250 }).then(() => this.showFlash('Sync reset: chords 250 ms early'))
      case MENU.info: this.view = 'info'; return this.render()
      case MENU.bigChord: return savePrefs({ bigChord: !prefs.bigChord })
      case MENU.reload: return this.reloadChart(false)
      case MENU.saveRecording: return this.finishRecording(true)
      case MENU.discardRecording: return this.finishRecording(false)
      case MENU.restartRecording: return this.startRecording()
    }
  }

  // ---------- listening ----------

  private async armMic() {
    const source = prefs.listen === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
    await serial(b => b.audioControl(true, source)).catch(e => debug('mic', e))
  }

  private async startListening() {
    await this.listening.start()
    if (this.listening.state !== 'on') return
    if (this.devAudioUrl) {
      this.stopDevAudio?.()
      this.stopDevAudio = startDevAudioStream(
        this.devAudioUrl,
        bytes => this.listening.audio(bytes, this.clock.position() - 60, this.clock.playing),
        msg => { this.listening.message = msg; this.render() },
      )
    } else if (getBridge()) {
      await this.armMic()
    }
    // Line up the chart that's already loaded.
    const cs = this.chartState
    if (cs.status === 'ready' && this.playback) {
      this.listening.setChart(isTimed(cs.chart) ? null : cs.chart, this.clock.durationMs, `${this.playback.trackId}|ready`)
    }
  }

  private async stopListening() {
    this.stopDevAudio?.()
    this.stopDevAudio = null
    if (getBridge()) await serial(b => b.audioControl(false)).catch(() => {})
    this.listening.stop()
  }

  /**
   * When a song ends after being lined up well, keep its timing as your chart
   * for that track, so next time it's in sync from the first chord.
   */
  private async saveListenedTiming() {
    const a = this.listening.alignment
    const cs = this.chartState
    const p = this.playback
    if (!a || cs.status !== 'ready' || !p || this.demo || isTimed(cs.chart)) return
    const heardMs = a.runs.reduce((s, r) => s + (r.endMs - r.startMs), 0)
    if (a.fit < 0.65 || heardMs < 0.6 * this.clock.durationMs) return
    if (await hasUserChart(p.trackId)) return
    const firstState = a.runs[0]?.state ?? 0
    const events = [
      // Chords before listening started stay untimed (spread from the start of the song).
      ...a.states.slice(0, firstState).map(s => ({ t: null, chord: s.chord, section: s.section || undefined })),
      ...a.runs.map(r => ({ t: Math.max(0, Math.round(r.startMs)), chord: a.states[r.state].chord, section: a.states[r.state].section || undefined })),
    ]
    await saveUserChart(p.trackId, { ...cs.chart, title: p.title, artist: p.artists, events })
    debug('saved listened timing', p.title, events.length)
  }

  // ---------- recording ----------

  private startRecording() {
    const cs = this.chartState
    if (cs.status !== 'ready') return
    this.record = {
      chart: { ...cs.chart, events: cs.chart.events.map(e => ({ ...e, t: null })) },
      next: 0,
      stamps: [],
    }
    this.view = 'record'
    this.showFlash('Restart the song, then tap as each chord starts')
  }

  private stampChord() {
    const r = this.record
    if (!r || r.next >= r.chart.events.length) return
    const t = Math.max(0, Math.round(this.clock.position() - TAP_REACTION_MS))
    const prev = r.chart.events.slice(0, r.next).reverse().find(e => e.t !== null)?.t ?? -1
    if (t <= prev) return this.showFlash('That was before the last chord; restart the song?')
    const ev = r.chart.events
    ev[r.next].t = t
    r.stamps.push(r.next)
    r.next++
    // Repeats of the same chord ("C C" = two bars) have no audible change to tap
    // on: leave them untimed so they share the time until the next change.
    while (r.next < ev.length && ev[r.next].chord === ev[r.next - 1].chord && ev[r.next].section === ev[r.next - 1].section) r.next++
    if (r.next >= r.chart.events.length) return void this.finishRecording(true)
    this.render()
  }

  private undoStamp() {
    const r = this.record
    const last = r?.stamps.pop()
    if (!r || last === undefined) return
    r.chart.events[last].t = null
    r.next = last
    this.showFlash('Undid last tap')
  }

  private skipChord() {
    const r = this.record
    if (!r || r.next >= r.chart.events.length) return
    r.next++
    this.showFlash('Skipped: its time will be estimated')
  }

  private async finishRecording(save: boolean) {
    const r = this.record
    this.record = null
    this.view = 'main'
    const id = this.playback?.trackId
    if (save && r && id && r.stamps.length) {
      if (!this.demo) await saveUserChart(id, r.chart)
      const chart = { ...r.chart, source: 'user' as const }
      this.chartState = { status: 'ready', chart, info: songInfo(chart, this.clock.durationMs, prefs.transpose) }
      this.showFlash(`Saved ${r.stamps.length} chord times`)
      return
    }
    this.showFlash(save ? 'Nothing recorded' : 'Recording discarded')
  }
}

const wrapTranspose = (n: number) => ((n + 6 + 120) % 12) - 6 // keep within -6..+5
const fmtSigned = (n: number) => (n > 0 ? `+${n}` : `${n}`)
const clipLine = (s: string) => (s.length > 48 ? s.slice(0, 45) + '...' : s)
