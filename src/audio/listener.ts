// Live chord listening: 16 kHz mono PCM (the glasses mic format) in, per-frame
// chord-family probabilities on the song's timeline out.
//
// Audio is resampled to the model's 22,050 Hz and kept for the last ~14 s.
// Each analysis step takes the newest 108 model frames (~10 s) plus a margin
// on the left (CQT edge effects), runs ChordMini on that one window and stores
// the frame probabilities by song position. A frame is re-estimated by later
// windows until it has had enough audio after it, so recent frames firm up
// over a few seconds.

import { familyMap, smoothedProbs, vocabLabel, type ChordModel } from './chordModel'
import { computeCqt } from './cqt'

/** 12 roots x (major-like, minor-like) + no chord. */
export const FAMILIES = 25
export const NO_CHORD = 24
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const familyName = (f: number) => (f === NO_CHORD ? '' : NOTES[f >> 1] + (f & 1 ? 'm' : ''))

const MARGIN = 16 // frames dropped on the left of each window (CQT edge effects)
const SETTLED = 24 // frames of audio after a frame before later windows stop replacing it

export interface HeardFrame {
  /** Song position of the frame centre, ms. */
  songMs: number
  /** Probability of each family. */
  fam: Float32Array
  /** Most likely full label, e.g. "Dm7". */
  label: string
  /** Frames of audio after this frame in the window it was last estimated from. */
  context: number
}

export class ChordListener {
  /** Heard frames keyed by song frame number (song ms / frame length). */
  private readonly frames = new Map<number, HeardFrame>()
  private readonly sr: number
  private readonly hop: number
  private readonly seqLen: number
  readonly frameMs: number
  private readonly famOf: Int8Array
  private buffer = new Float32Array(0)
  /** Model-rate samples received since the last audio reset. */
  private total = 0
  /** Song ms of model-rate sample 0 since the last audio reset. */
  private originMs: number | null = null
  private origins: number[] = []
  private resamplePos = 0
  private last16 = 0
  private busy = false
  lastAnalysisMs = 0

  constructor(private readonly model: ChordModel) {
    this.sr = model.config.sampleRate
    this.hop = model.config.hopLength
    this.seqLen = model.config.seqLen
    this.frameMs = (this.hop / this.sr) * 1000
    this.famOf = familyMap(model.config.chordVocab)
  }

  /** New track: forget everything. */
  reset() {
    this.frames.clear()
    this.resetAudio()
  }

  /** Pause, seek or a gap in the audio: start a fresh audio stream but keep what was heard. */
  resetAudio() {
    this.buffer = new Float32Array(0)
    this.total = 0
    this.originMs = null
    this.origins = []
    this.resamplePos = 0
    this.last16 = 0
  }

  /** Adds 16 kHz mono audio; `endSongMs` is the song position when its last sample was heard. */
  push(pcm16k: Float32Array, endSongMs: number) {
    if (!pcm16k.length) return
    // Linear-interpolation resample; the CQT tops out near 2 kHz, so imaging above 8 kHz is harmless.
    const step = 16000 / this.sr
    const count = Math.max(0, Math.ceil((pcm16k.length - this.resamplePos) / step))
    const chunk = new Float32Array(count)
    let pos = this.resamplePos
    for (let j = 0; j < count; j++, pos += step) {
      const i = Math.floor(pos)
      const a = i === 0 ? this.last16 : pcm16k[i - 1]
      const b = pcm16k[i]
      chunk[j] = a + (b - a) * (pos - i)
    }
    this.resamplePos = pos - pcm16k.length
    this.last16 = pcm16k[pcm16k.length - 1]

    const keep = Math.round(this.sr * 14)
    const merged = new Float32Array(Math.min(keep, this.buffer.length + chunk.length))
    const fromOld = merged.length - chunk.length
    if (fromOld > 0) merged.set(this.buffer.subarray(this.buffer.length - fromOld), 0)
    merged.set(chunk.subarray(Math.max(0, chunk.length - merged.length)), Math.max(0, fromOld))
    this.total += chunk.length
    this.buffer = merged

    // Sample 0's song position: median of recent estimates so chunk jitter doesn't wobble frame times.
    this.origins.push(endSongMs - (this.total / this.sr) * 1000)
    if (this.origins.length > 40) this.origins.shift()
    const sorted = [...this.origins].sort((x, y) => x - y)
    this.originMs = sorted[sorted.length >> 1]
  }

  /** Runs one analysis step on the newest audio. Returns false if there wasn't enough yet. */
  async analyze(): Promise<boolean> {
    if (this.busy || this.originMs === null) return false
    const { nBins, numChords, smoothingKernel, chordVocab } = this.model.config
    const bufferStart = this.total - this.buffer.length
    const endFrame = Math.floor((this.total - 1) / this.hop)
    const segFrame = Math.max(Math.ceil(bufferStart / this.hop), endFrame - (this.seqLen - 1) - MARGIN)
    if (endFrame - segFrame < 40) return false
    this.busy = true
    const t0 = performance.now()
    try {
      const segment = this.buffer.subarray(segFrame * this.hop - bufferStart)
      const { frameCount, data } = computeCqt(segment, this.model.plan)
      // Drop the left margin unless this is the very start of the stream.
      const validFrom = segFrame === 0 ? 0 : Math.min(MARGIN, frameCount - 40)
      const usable = Math.min(this.seqLen, frameCount - validFrom)
      const from = frameCount - usable
      const pad = this.seqLen - usable
      const win = new Float32Array(this.seqLen * nBins)
      win.set(data.subarray(from * nBins, frameCount * nBins), pad * nBins)
      const [logits] = await this.model.run([win])
      const probs = smoothedProbs(logits, this.seqLen, numChords, smoothingKernel)

      for (let w = pad; w < this.seqLen; w++) {
        const absFrame = segFrame + from + (w - pad)
        const songMs = this.originMs + absFrame * this.frameMs
        const key = Math.round(songMs / this.frameMs)
        const context = this.seqLen - 1 - w
        const old = this.frames.get(key)
        if (old && old.context >= SETTLED && context <= old.context) continue
        const fam = new Float32Array(FAMILIES)
        let best = 0
        for (let c = 0; c < numChords; c++) {
          const p = probs[w * numChords + c]
          fam[this.famOf[c]] += p
          if (p > probs[w * numChords + best]) best = c
        }
        this.frames.set(key, { songMs, fam, label: vocabLabel(chordVocab[best]), context })
      }
      return true
    } finally {
      this.lastAnalysisMs = performance.now() - t0
      this.busy = false
    }
  }

  /** Everything heard for this track, in song order. */
  heard(): HeardFrame[] {
    return [...this.frames.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])
  }

  get frameCount() {
    return this.frames.size
  }

  /** The chord heard most recently: majority over ~1 s, ending a few frames before the newest. */
  current(): { label: string; family: number; confidence: number; songMs: number } | null {
    const all = this.heard()
    const recent = all.slice(-14, -3)
    if (!recent.length) return null
    const sum = new Float32Array(FAMILIES)
    for (const f of recent) for (let k = 0; k < FAMILIES; k++) sum[k] += f.fam[k]
    let best = 0
    for (let k = 1; k < FAMILIES; k++) if (sum[k] > sum[best]) best = k
    if (best === NO_CHORD) return null
    const labels = recent.filter(f => argmax(f.fam) === best).map(f => f.label)
    return { label: mode(labels) || familyName(best), family: best, confidence: sum[best] / recent.length, songMs: recent[recent.length - 1].songMs }
  }
}

function argmax(a: Float32Array): number {
  let best = 0
  for (let k = 1; k < a.length; k++) if (a[k] > a[best]) best = k
  return best
}

function mode(xs: string[]): string {
  const m = new Map<string, number>()
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}
