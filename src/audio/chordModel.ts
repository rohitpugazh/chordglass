// ChordMini (ChordNet "2E1D", ptnghia-j/ChordMini, MIT; ONNX export
// musetric/chordmini-onnx, MIT): log-CQT windows in, per-frame chord logits out.
// Runs on onnxruntime-web's WebAssembly backend, single-threaded (GitHub Pages
// and the Even app's WebView aren't cross-origin isolated, so no threads).

import type { InferenceSession, Tensor } from 'onnxruntime-web'
import { decodeCqtPlan, type CqtPlan } from './cqt'

export interface ChordModelConfig {
  seqLen: number
  sampleRate: number
  hopLength: number
  nBins: number
  numChords: number
  smoothingKernel: number
  chordVocab: string[]
}

/** The graph is static: always exactly this many windows per run. */
export const BATCH = 16

export class ChordModel {
  private constructor(
    private readonly session: InferenceSession,
    private readonly ort: typeof import('onnxruntime-web'),
    readonly config: ChordModelConfig,
    readonly plan: CqtPlan,
  ) {}

  /**
   * Loads config, CQT plan and model from `modelUrl` (config.json,
   * cqt-plan.bin, chordnet.onnx). The onnxruntime wasm file is bundled by Vite.
   */
  static async load(modelUrl: string, onProgress?: (text: string) => void): Promise<ChordModel> {
    const base = modelUrl.endsWith('/') ? modelUrl : modelUrl + '/'
    const get = async (name: string) => {
      const res = await fetch(base + name)
      if (!res.ok) throw new Error(`Chord model: ${name} HTTP ${res.status}`)
      return res
    }
    onProgress?.('Loading chord model...')
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.numThreads = 1
    const [config, planBytes, modelBytes] = await Promise.all([
      get('config.json').then(r => r.json() as Promise<ChordModelConfig>),
      get('cqt-plan.bin').then(r => r.arrayBuffer()),
      get('chordnet.onnx').then(r => r.arrayBuffer()),
    ])
    onProgress?.('Starting chord model...')
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    return new ChordModel(session, ort as unknown as typeof import('onnxruntime-web'), config, decodeCqtPlan(planBytes))
  }

  /** From an already-created session (tests). */
  static fromSession(session: InferenceSession, ort: typeof import('onnxruntime-web'), config: ChordModelConfig, plan: CqtPlan) {
    return new ChordModel(session, ort, config, plan)
  }

  /**
   * Runs up to BATCH windows of [seqLen][nBins] features; returns their
   * [seqLen][numChords] logits. Unused slots are zero windows, which the
   * model treats independently, so they change nothing.
   */
  async run(windows: Float32Array[]): Promise<Float32Array[]> {
    const { seqLen, nBins, numChords } = this.config
    const per = seqLen * nBins
    const input = new Float32Array(BATCH * per)
    windows.slice(0, BATCH).forEach((w, i) => input.set(w, i * per))
    const feeds: Record<string, Tensor> = { features: new this.ort.Tensor('float32', input, [BATCH, seqLen, nBins]) }
    const out = await this.session.run(feeds)
    const logits = out.logits.data as Float32Array
    const perOut = seqLen * numChords
    return windows.slice(0, BATCH).map((_, i) => logits.slice(i * perOut, (i + 1) * perOut))
  }
}

/** ChordMini's decision rule: average logits over a 9-frame window (edges clamped), then softmax. */
export function smoothedProbs(logits: Float32Array, frames: number, classes: number, kernel: number): Float32Array {
  const out = new Float32Array(frames * classes)
  const half = kernel >> 1
  for (let t = 0; t < frames; t++) {
    let max = -Infinity
    for (let c = 0; c < classes; c++) {
      let s = 0
      for (let d = -half; d <= half; d++) {
        const u = Math.min(frames - 1, Math.max(0, t + d))
        s += logits[u * classes + c]
      }
      const v = s / kernel
      out[t * classes + c] = v
      if (v > max) max = v
    }
    let sum = 0
    for (let c = 0; c < classes; c++) {
      const e = Math.exp(out[t * classes + c] - max)
      out[t * classes + c] = e
      sum += e
    }
    for (let c = 0; c < classes; c++) out[t * classes + c] /= sum
  }
  return out
}

/**
 * Collapses the 170 classes into 25 "families": 12 roots x (major-like,
 * minor-like) plus no-chord. Major-like: maj, 7, maj7, maj6, aug, sus2, sus4.
 * Minor-like: min, min7, min6, minmaj7, dim, dim7, hdim7.
 */
export function familyMap(vocab: string[]): Int8Array {
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const map = new Int8Array(vocab.length)
  vocab.forEach((label, i) => {
    if (label === 'N' || label === 'X') { map[i] = 24; return }
    const [root, quality = ''] = label.split(':')
    const r = NOTES.indexOf(root)
    const minor = /^(min|dim|hdim)/.test(quality)
    map[i] = r < 0 ? 24 : r * 2 + (minor ? 1 : 0)
  })
  return map
}

/** Readable label for a vocabulary entry, in the app's chord spelling ("A#:min7" -> "A#m7"). */
export function vocabLabel(label: string): string {
  if (label === 'N' || label === 'X') return ''
  const [root, q = ''] = label.split(':')
  const suffix: Record<string, string> = {
    '': '', min: 'm', dim: 'dim', aug: 'aug', min6: 'm6', maj6: '6', min7: 'm7', minmaj7: 'mmaj7',
    maj7: 'maj7', '7': '7', dim7: 'dim7', hdim7: 'm7b5', sus2: 'sus2', sus4: 'sus4',
  }
  return root + (suffix[q] ?? '')
}
