// Auto-timing by listening: audio from the glasses mic (or the phone mic, or a
// dev stream of this computer's audio) goes through ChordMini; the chart is
// lined up with what was heard, so its chords move with the music without
// tapping along. With no chart (or one that doesn't match), it shows the chord
// it hears instead.

import { align, alignStates, detectShift, shiftStates, type Alignment, type AlignState } from '../audio/align'
import { ChordModel } from '../audio/chordModel'
import { ChordListener } from '../audio/listener'
import type { Chart } from '../chart/chart'

export type ListenState = 'off' | 'loading' | 'on' | 'error'

let modelPromise: Promise<ChordModel> | null = null

export function modelBaseUrl(): string {
  return import.meta.env.VITE_MODEL_URL || new URL('models/', location.href).href
}

/** Loads the model once per page (17 MB + the 15 MB runtime the first time, then from the browser cache). */
function loadModel(onProgress: (s: string) => void): Promise<ChordModel> {
  modelPromise ??= ChordModel.load(modelBaseUrl() + 'chordmini/', onProgress).catch(e => {
    modelPromise = null
    throw e
  })
  return modelPromise
}

/** PCM16LE bytes -> floats, carrying an odd trailing byte to the next chunk. */
export class Pcm16Decoder {
  private carry: number | null = null
  decode(bytes: Uint8Array): Float32Array {
    let b = bytes
    if (this.carry !== null) {
      const joined = new Uint8Array(b.length + 1)
      joined[0] = this.carry
      joined.set(b, 1)
      b = joined
      this.carry = null
    }
    if (b.length % 2) { this.carry = b[b.length - 1]; b = b.subarray(0, b.length - 1) }
    const out = new Float32Array(b.length / 2)
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }
}

export class Listening {
  state: ListenState = 'off'
  message = ''
  private listener: ChordListener | null = null
  private decoder = new Pcm16Decoder()
  private timer = 0
  private states: AlignState[] = []
  private statesFor = ''
  /** Semitones the recording sits from the chart (e.g. -1: tuned a half step down). */
  shift = 0
  alignment: Alignment | null = null
  /** Audio received recently (ms timestamp), to tell "no sound" from "not started". */
  lastAudioAt = 0
  analysisMs = 0

  constructor(private readonly onUpdate: () => void) {}

  get active() {
    return this.state === 'on' || this.state === 'loading'
  }

  async start(): Promise<void> {
    if (this.active) return
    this.state = 'loading'
    this.message = 'Loading chord model...'
    this.onUpdate()
    try {
      const model = await loadModel(m => { this.message = m; this.onUpdate() })
      if (this.state !== 'loading') return // stopped meanwhile
      this.listener = new ChordListener(model)
      this.state = 'on'
      this.message = 'Listening'
      this.schedule(500)
    } catch (e) {
      this.state = 'error'
      this.message = `Couldn't load the chord model: ${(e as Error).message}`
    }
    this.onUpdate()
  }

  stop() {
    this.state = 'off'
    this.message = ''
    clearTimeout(this.timer)
    this.listener?.reset()
    this.alignment = null
    this.onUpdate()
  }

  /** New track: start over. */
  trackChanged() {
    this.listener?.reset()
    this.alignment = null
    this.statesFor = ''
  }

  /** Pause, resume or seek: the audio stream restarts on the song timeline. */
  clockJumped() {
    this.listener?.resetAudio()
  }

  /** Audio chunk (PCM16LE 16 kHz mono) heard at song position `songMs` (its end). */
  audio(bytes: Uint8Array, songMs: number, playing: boolean) {
    const pcm = this.decoder.decode(bytes)
    if (!this.listener || this.state !== 'on') return
    this.lastAudioAt = Date.now()
    if (!playing) return
    this.listener.push(pcm, songMs)
  }

  /** What the model hears right now (no chart needed). */
  heard() {
    return this.listener?.current() ?? null
  }

  get framesHeard() {
    return this.listener?.frameCount ?? 0
  }

  private chart: Chart | null = null
  private durationMs = 0

  /** The chart to line up (null: just report heard chords). */
  setChart(chart: Chart | null, durationMs: number, key: string) {
    this.chart = chart
    this.durationMs = durationMs
    if (key !== this.statesFor) {
      this.states = chart ? alignStates(chart, durationMs) : []
      this.statesFor = key
      this.alignment = null
      this.shift = 0
    }
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    if (this.state === 'on') this.timer = window.setTimeout(() => void this.step(), ms)
  }

  private async step() {
    const l = this.listener
    if (!l || this.state !== 'on') return
    try {
      const ran = await l.analyze()
      this.analysisMs = l.lastAnalysisMs
      if (ran && this.chart && this.states.length) {
        const heard = l.heard()
        // Once there's enough to go on, check whether the recording is in another key than the chart.
        if (heard.length > 120) this.shift = detectShift(this.states, heard).shift
        this.alignment = align(shiftStates(this.states, this.shift), heard, this.durationMs, l.frameMs)
      }
      if (ran) this.onUpdate()
    } catch (e) {
      this.message = `Listening error: ${(e as Error).message}`
    }
    // Keep the CPU use bounded: wait at least twice as long as an analysis takes.
    this.schedule(Math.max(1200, 2 * l.lastAnalysisMs))
  }
}

/**
 * Streams raw PCM16 16 kHz mono from a URL (scripts/loopback.py serve): the
 * computer's own audio, standing in for the glasses mic during development.
 */
export function startDevAudioStream(url: string, onBytes: (b: Uint8Array) => void, onError: (msg: string) => void): () => void {
  const controller = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value?.length) onBytes(value)
      }
    } catch (e) {
      if (!controller.signal.aborted) onError(`Audio stream: ${(e as Error).message}`)
    }
  })()
  return () => controller.abort()
}
